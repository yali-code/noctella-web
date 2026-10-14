const fs=require('node:fs'),path=require('node:path');const {connect,then}=require('./protocol.cjs');
const Module=require('node:module');const resolve=Module._resolveFilename;Module._resolveFilename=function(id,...rest){return id==='@noctella/shared'?path.resolve(__dirname,'../../packages/shared/dist/index.js'):resolve.call(this,id,...rest);};
const [root,driver,schema,mode]=process.argv.slice(2);
const checkpoint=phase=>{const record={phase,driver,mode,sourceSha:process.env.NOCTELLA_PROBE_SOURCE_SHA||'local'};fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify(record,null,2));fs.writeSync(1,JSON.stringify(record)+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
(async()=>{const p=await connect(driver,root,schema);
 if(mode==='lock-race'){
 if(driver==='sqlite')p.connection.pragma('busy_timeout = 200');else await p.connection.query("SET lock_timeout='200ms'");
 process.send({ready:true});process.once('message',async()=>{try{const token=await p.reclaim('lock',1,'boot-b','claim-b',300,100);fs.writeFileSync(path.join(root,'lock-result.json'),JSON.stringify({token}));}catch(error){fs.writeFileSync(path.join(root,'lock-result.json'),JSON.stringify({blocked:true,code:error.code}));}finally{await p.close();process.disconnect();}});return;
 }
 if(mode==='race'){process.send({ready:true});process.once('message',async({owner})=>{try{const token=await p.reclaim('race',1,owner,'claim-'+owner,200,1000);process.send({token});await p.close();process.disconnect();}catch(e){process.send({error:e.message});process.exit(2);}});return;}
 const token=await p.create('kill','boot-a','claim-a',100,1000);const dir=path.join(root,'operations','kill','g1');fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'output.webp');
 if(mode==='intent')checkpoint('intent-before-file');fs.writeFileSync(file,'',{flag:'wx',mode:0o600});if(mode==='reserved')checkpoint('zero-byte-reserved');
 fs.writeFileSync(file,'synthetic-complete-photo');if(mode==='materialized')checkpoint('materialized-before-prepared');await p.transition(token,101,'prepared');
 if(mode==='prepared')checkpoint('prepared-before-domain');
 await p.transition(token,102,'committed',q=>then(q("INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,created_at,updated_at) VALUES('kill-photo','synthetic-product','/kill.webp','/kill-thumb.webp','kill.webp','image/webp',24,32,24,?,?) RETURNING id",['2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z']),()=>then(q("INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at,created_at,updated_at) VALUES('kill-event','product_photo.promote_requested','ProductPhoto','kill-photo','kill-promote',?,'Pending',?,?,?) RETURNING id",[JSON.stringify({photoId:'kill-photo',storageKey:'kill.webp'}),'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z']),()=>{if(mode==='uncommitted')checkpoint('domain-and-journal-before-commit');})),{photoId:'kill-photo',eventId:'kill-event'});
 checkpoint('domain-and-journal-after-commit');
})().catch(error=>{fs.writeSync(2,JSON.stringify({name:error.name,code:error.code,message:error.message})+'\n');process.exit(2);});
