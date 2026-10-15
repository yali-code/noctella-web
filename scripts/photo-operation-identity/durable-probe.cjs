'use strict';
// Offline SQLite WAL proof only. No API imports, production tables, migrations or filesystem publication.
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs');
const {createRequire}=require('node:module');
const api=createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const {classify}=require('./identity.cjs');
const keys=['tenantId','actorId','productId','kind','token','sha256','altText'];
function store(root) {
  const real=fs.realpathSync(root);
  if(!real.startsWith(path.join(os.tmpdir(),'noctella-w2-proof-'))) throw Error('DISPOSABLE_ROOT_REQUIRED');
  const Database=api('better-sqlite3');
  const db=new Database(path.join(real,'identity.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 2000');
  db.exec(`
CREATE TABLE IF NOT EXISTS probe_w2_ops (
 token TEXT PRIMARY KEY, intent TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL CHECK(state IN ('receiving','committed','review')),
 lease_until INTEGER NOT NULL, photo_id TEXT, outbox_id TEXT
);
CREATE TABLE IF NOT EXISTS probe_w2_photos (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS probe_w2_outbox (id TEXT PRIMARY KEY, photo_id TEXT NOT NULL UNIQUE);
`);
  const get= db.prepare('SELECT * FROM probe_w2_ops WHERE token=?');
  const required=(intent,now,ttl)=>{
    if(classify(null,intent)!=='NEW') throw Error('INVALID_INTENT');
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(ttl)||ttl<=0||!Number.isSafeInteger(now+ttl))throw Error('INVALID_LEASE');
    return JSON.stringify(Object.fromEntries(keys.map(k=>[k,intent[k]])));
  };
  const claim=db.transaction((intent,now,ttl)=>{
    const packed=required(intent,now,ttl);
    const existing=get.get(intent.token);
    if(!existing) {
      db.prepare("INSERT INTO probe_w2_ops(token,intent,generation,state,lease_until) VALUES(?,?,1,'receiving',?)").run(intent.token,packed,now+ttl);
      return {status:'NEW',generation:1};
    }
    if(classify(JSON.parse(existing.intent),intent)!=='SAME_INTENT')return {status:'CONFLICT'};
    if(existing.state==='committed')return {status:'COMMITTED',photoId:existing.photo_id,outboxId:existing.outbox_id};
    if(existing.state==='review')return {status:'REVIEW'};
    return {status:'IN_PROGRESS',generation:existing.generation};
  });
  const reclaim=db.transaction((intent,expected,now,ttl)=>{
    required(intent,now,ttl);
    const existing=get.get(intent.token);
    if(!existing||classify(JSON.parse(existing.intent),intent)!=='SAME_INTENT')return {status:'CONFLICT'};
    if(existing.state==='committed')return {status:'COMMITTED',photoId:existing.photo_id,outboxId:existing.outbox_id};
    const changed=db.prepare("UPDATE probe_w2_ops SET generation=generation+1,lease_until=? WHERE token=? AND generation=? AND lease_until<=? AND state='receiving'").run(now+ttl,intent.token,expected,now);
    return changed.changes===1?{status:'RECLAIMED',generation:expected+1}:{status:'RETAIN'};
  });
  const commit=db.transaction((intent,generation,photoId,outboxId)=>{
    if(classify(null,intent)!=='NEW'||![photoId,outboxId].every(v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)))throw Error('INVALID_COMMIT');
    const row=get.get(intent.token);
    if(!row||classify(JSON.parse(row.intent),intent)!=='SAME_INTENT'||row.generation!==generation||row.state!=='receiving') throw Error('STALE_FENCE');
    db.prepare('INSERT INTO probe_w2_photos(id,token) VALUES(?,?)').run(photoId,intent.token);
    db.prepare('INSERT INTO probe_w2_outbox(id,photo_id) VALUES(?,?)').run(outboxId,photoId);
    db.prepare("UPDATE probe_w2_ops SET state='committed',photo_id=?,outbox_id=? WHERE token=? AND generation=? AND state='receiving'").run(photoId,outboxId,intent.token,generation);
  });
  return {claim,reclaim,commit,read:token=>get.get(token),snapshot:()=>({
    operations:db.prepare('SELECT * FROM probe_w2_ops ORDER BY token').all(),
    photos:db.prepare('SELECT * FROM probe_w2_photos ORDER BY id').all(),
    outbox:db.prepare('SELECT * FROM probe_w2_outbox ORDER BY id').all()
  }),close:()=>db.close()};
}
module.exports={store};
