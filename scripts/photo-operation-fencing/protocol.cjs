// DISPOSABLE TEST PROTOTYPE ONLY. No application imports, production migration or cleanup authority.
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {createRequire}=require('node:module');const api=createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const then=(value,next)=>value instanceof Promise?value.then(next):next(value);
const ddl=`CREATE TABLE IF NOT EXISTS probe_photo_operations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 generation BIGINT NOT NULL CHECK(generation>0), owner TEXT NOT NULL, nonce TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('receiving','prepared','committed','review')),
 lease_until BIGINT NOT NULL, created_ms BIGINT NOT NULL, updated_ms BIGINT NOT NULL,
 photo_id TEXT, event_id TEXT);
CREATE TABLE IF NOT EXISTS probe_photo_generations (
 operation_id TEXT NOT NULL REFERENCES probe_photo_operations(id), generation BIGINT NOT NULL,
 owner TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL,
 input_ref TEXT NOT NULL, output_ref TEXT NOT NULL, lease_until BIGINT NOT NULL,
 created_ms BIGINT NOT NULL, updated_ms BIGINT NOT NULL,
 PRIMARY KEY(operation_id,generation), UNIQUE(operation_id,nonce));`;
function rootGuard(root){const base=path.join(os.tmpdir(),'noctella-photo-fence-');if(!path.resolve(root).startsWith(base)||fs.realpathSync(root)!==path.resolve(root))throw Error('DISPOSABLE_ROOT_REQUIRED');}
async function connect(driver,root,schemaName){rootGuard(root);let connection;
 if(driver==='sqlite'){const Database=api('better-sqlite3');connection=new Database(path.join(root,'probe.sqlite'));connection.pragma('journal_mode = WAL');connection.pragma('busy_timeout = 5000');connection.pragma('foreign_keys = ON');}
 else if(driver==='postgres'){
  require('../../apps/api/tests/postgresTestDb.ts').assertDisposablePostgresUrl(process.env.POSTGRES_TEST_DATABASE_URL);
  const u=new URL(process.env.POSTGRES_TEST_DATABASE_URL);if(!['127.0.0.1','localhost'].includes(u.hostname)||!/^sprint151_test_[a-f0-9]+$/.test(schemaName))throw Error('LOCAL_TEST_DATABASE_REQUIRED');
  connection=new(api('pg').Client)({connectionString:process.env.POSTGRES_TEST_DATABASE_URL,options:'-c search_path='+schemaName});await connection.connect();
 }else throw Error('UNKNOWN_DRIVER');
 const query=(sql,args=[])=>driver==='sqlite'?connection.prepare(sql).all(...args):connection.query(sql.replace(/\?/g,()=>'$'+(++query.index)),args).then(r=>r.rows);
 const q=(sql,args=[])=>{query.index=0;return query(sql,args);};
 const transaction=work=>{
  if(driver==='sqlite')return connection.transaction(()=>{const result=work();if(result instanceof Promise)throw Error('ASYNC_SQLITE_PROBE_CALLBACK');return result;}).immediate();
  return(async()=>{await connection.query('BEGIN');try{const result=await work();await connection.query('COMMIT');return result;}catch(error){await connection.query('ROLLBACK');throw error;}})();
 };
 const decode=row=>row?{...row,generation:Number(row.generation),lease_until:Number(row.lease_until),created_ms:Number(row.created_ms),updated_ms:Number(row.updated_ms)}:null;
 const token=row=>({id:row.id,generation:Number(row.generation),owner:row.owner,nonce:row.nonce});
 const read=id=>then(q('SELECT * FROM probe_photo_operations WHERE id=?',[id]),r=>decode(r[0]));
 const history=(row,now)=>q('INSERT INTO probe_photo_generations(operation_id,generation,owner,nonce,state,input_ref,output_ref,lease_until,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *',[row.id,row.generation,row.owner,row.nonce,row.state,'operations/'+row.id+'/g'+row.generation+'/input','operations/'+row.id+'/g'+row.generation+'/output.webp',row.lease_until,now,now]);
 const validate=(id,owner,nonce,now,ttl)=>{if(!/^[a-z0-9-]{1,64}$/.test(id)||!owner||!nonce||!Number.isSafeInteger(now)||!Number.isSafeInteger(ttl)||ttl<=0||!Number.isSafeInteger(now+ttl))throw Error('INVALID_INTENT');};
 const create=(id,owner,nonce,now,ttl)=>{validate(id,owner,nonce,now,ttl);return transaction(()=>then(q("INSERT INTO probe_photo_operations(id,kind,entity_id,generation,owner,nonce,state,lease_until,created_ms,updated_ms) VALUES(?,'synthetic-photo','synthetic-product',1,?,?,'receiving',?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *",[id,owner,nonce,now+ttl,now,now]),r=>r.length?then(history(decode(r[0]),now),()=>token(r[0])):null));};
 const reclaim=(id,expected,owner,nonce,now,ttl)=>{validate(id,owner,nonce,now,ttl);return transaction(()=>then(q("UPDATE probe_photo_operations SET generation=generation+1,owner=?,nonce=?,state='receiving',lease_until=?,updated_ms=? WHERE id=? AND generation=? AND lease_until<=? AND state IN ('receiving','prepared') RETURNING *",[owner,nonce,now+ttl,now,id,expected,now]),r=>r.length?then(q("UPDATE probe_photo_generations SET state='superseded',updated_ms=? WHERE operation_id=? AND generation=? RETURNING *",[now,id,expected]),()=>then(history(decode(r[0]),now),()=>token(r[0]))):null));};
 const renew=(t,now,ttl)=>{validate(t.id,t.owner,t.nonce,now,ttl);return transaction(()=>then(q("UPDATE probe_photo_operations SET lease_until=?,updated_ms=? WHERE id=? AND generation=? AND owner=? AND nonce=? AND lease_until>? AND state IN ('receiving','prepared') RETURNING *",[now+ttl,now,t.id,t.generation,t.owner,t.nonce,now]),r=>r.length?then(q('UPDATE probe_photo_generations SET lease_until=?,updated_ms=? WHERE operation_id=? AND generation=? RETURNING *',[now+ttl,now,t.id,t.generation]),()=>true):false));};
 // Trusted test callbacks only. A production API must expose sealed operations, not arbitrary callbacks.
 const fenced=(t,now,work)=>transaction(()=>then(q('SELECT * FROM probe_photo_operations WHERE id=?'+(driver==='postgres'?' FOR UPDATE':''),[t.id]),r=>{
  const row=decode(r[0]);if(!row||row.generation!==t.generation||row.owner!==t.owner||row.nonce!==t.nonce||row.lease_until<=now||!['receiving','prepared'].includes(row.state))throw Error('STALE_FENCE');
  return work({q,row});
 }));
 const transition=(t,now,next,work=()=>undefined,links={})=>{if(!['prepared','committed','review'].includes(next))throw Error('INVALID_STATE');return fenced(t,now,({q,row})=>{
  if(next==='prepared'&&row.state!=='receiving')throw Error('INVALID_TRANSITION');
  if(next==='committed'&&row.state!=='prepared')throw Error('INVALID_TRANSITION');
  if(next==='committed'&&(!links.photoId||!links.eventId))throw Error('COMMIT_REFERENCES_REQUIRED');
  return then(work(q),()=>then(next==='committed'?q('SELECT p.id FROM product_photos p JOIN outbox_events e ON e.aggregate_id=p.id WHERE p.id=? AND e.id=? AND p.product_id=?',[links.photoId,links.eventId,row.entity_id]):[],references=>{
   if(next==='committed'&&references.length!==1)throw Error('AUTHORITATIVE_REFERENCES_MISSING');
   return then(q('UPDATE probe_photo_operations SET state=?,updated_ms=?,photo_id=COALESCE(?,photo_id),event_id=COALESCE(?,event_id) WHERE id=? RETURNING *',[next,now,links.photoId||null,links.eventId||null,t.id]),()=>then(q('UPDATE probe_photo_generations SET state=?,updated_ms=? WHERE operation_id=? AND generation=? RETURNING *',[next,now,t.id,t.generation]),()=>true));
  }));
 });};
 return{driver,connection,q,transaction,read,create,reclaim,renew,fenced,transition,token,
 async initialize(){if(driver==='sqlite'){require('../../apps/api/src/db/migrate.ts').ensureSchema(connection);connection.exec(ddl);}else await connection.query(ddl);},
 async snapshot(){return{operations:await q('SELECT * FROM probe_photo_operations ORDER BY id'),generations:await q('SELECT * FROM probe_photo_generations ORDER BY operation_id,generation'),photos:await q('SELECT id,filename FROM product_photos ORDER BY id'),outbox:await q('SELECT id,event_type,aggregate_id,payload,status FROM outbox_events ORDER BY id')};},
 async close(){if(driver==='sqlite')connection.close();else await connection.end();}};
}
module.exports={connect,ddl,rootGuard,then};
