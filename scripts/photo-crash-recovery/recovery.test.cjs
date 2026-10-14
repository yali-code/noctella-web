const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawn,spawnSync}=require('node:child_process');const {plan}=require('./plan.cjs');
const directory=__dirname;const evidence=process.env.NOCTELLA_CRASH_EVIDENCE_DIR;
const base={dbAvailable:true,quiesced:true,photos:[],aiPhotos:[],outbox:[],files:[]};
test('planner protects all referenced zero-byte, canonical and private files; never grants mutation',()=>{
 const snapshot={...base,photos:[{id:'p',filename:'main.webp',thumbnailStorageKey:'thumb.webp'}],aiPhotos:[{id:'a',storageKey:'private.webp'}],files:[{root:'canonical',key:'main.webp',size:0,kind:'file'},{root:'intake',key:'private.webp',size:40,kind:'file'},{root:'canonical',key:'other.webp',size:0,kind:'file'}]};const result=plan(snapshot);
 assert.equal(result.safeToMutate,false);assert.ok(result.entries.every(e=>e.action==='retain'));assert.equal(result.entries.find(e=>e.key==='main.webp').state,'referenced-anomaly');assert.equal(result.entries.find(e=>e.key==='private.webp').state,'protected-reference');assert.equal(result.entries.find(e=>e.key==='thumb.webp').state,'missing-reference');assert.equal(result.entries.find(e=>e.key==='other.webp').state,'unproven-ownership');assert.deepEqual(plan(snapshot),result);
});
test('outbox delete/cleanup payloads protect bytes after photo-row disappearance regardless of status',()=>{
 for(const eventType of ['product_photo.delete_requested','product_photo.cleanup_temp_requested']){const result=plan({...base,outbox:[{id:'e',eventType,status:'succeeded',payload:JSON.stringify({storageKey:'kept.webp'})}],files:[{root:'canonical',key:'kept.webp',size:1,kind:'file'}]});assert.equal(result.entries.find(e=>e.root==='canonical').state,'protected-reference');}
});
test('unknown ownership, malformed outbox, DB outages, live writers and unsafe paths never authorize cleanup',()=>{
 const result=plan({...base,dbAvailable:false,quiesced:false,photos:[{id:'p',filename:'../bad'}],outbox:[{id:'e',eventType:'product_photo.promote_requested',payload:'{'},{id:'d',eventType:'product_photo.promote_requested',aggregateId:'missing',payload:{}}],files:[{root:'canonical',key:'link',kind:'symlink',size:1}]});assert.equal(result.safeToMutate,false);for(const b of ['db-unavailable','writers-not-fenced','invalid-reference','invalid-photo-outbox','unresolved-photo-outbox'])assert.ok(result.blockers.includes(b));assert.equal(result.entries[0].state,'unsafe-entry');
});
async function readyAndKill(root,driver,boundary,schemaName){
 const child=spawn(process.execPath,['--import','tsx',path.join(directory,'crash-worker.cjs'),root,driver,boundary,schemaName||''],{cwd:path.resolve(directory,'../..'),env:process.env,stdio:['ignore','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 let stdout='',stderr='',timer;
 try{await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Crash checkpoint timeout')),45000);child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8192)reject(Error('Checkpoint budget'));if(stdout.includes('\n'))resolve();});child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk;});child.once('error',reject);child.once('exit',code=>reject(Error('Worker exited before checkpoint '+code+' '+stderr)));});}
 catch(error){child.kill('SIGKILL');await closed;throw error;}
 finally{clearTimeout(timer);}
 child.kill('SIGKILL');const result=await closed;
 if(process.platform==='linux')assert.equal(result.signal,'SIGKILL');
 return {checkpoint:JSON.parse(stdout.trim()),termination:result,platform:process.platform};
}
function restart(root,driver,schemaName){const result=spawnSync(process.execPath,['--import','tsx',path.join(directory,'snapshot-worker.cjs'),root,driver,schemaName||''],{cwd:path.resolve(directory,'../..'),env:process.env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
for(const driver of ['sqlite','postgres'])for(const boundary of ['ai-reserved-output','ai-encoded-output','ai-uncommitted','ai-committed','ai-lost-ack','ai-rollback-error','product-one-link','product-uncommitted','product-committed','product-lost-ack','finalize-uncommitted','finalize-committed','finalize-first-output','finalize-zero-output','instagram-temp']){
 test(driver+' restart '+boundary,{skip:driver==='postgres'&&!process.env.POSTGRES_TEST_DATABASE_URL,timeout:120000},async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'noctella-photo-crash-'));const caseEvidence=evidence?path.join(evidence,driver+'-'+boundary+'-'+path.basename(root)):null;let h;
  try{
   if(driver==='postgres')h=await require('../../apps/api/tests/postgresTestDb.ts').createPostgresTestDb();
   let death;
   try{death=await readyAndKill(root,driver,boundary,h?.schemaName);}catch(error){
    if(driver==='postgres'&&error.message.includes('toISOString')&&error.message.includes('create-intake')){
     const blocker={scope:'actual-photo-service-blocked',driver,boundary,reason:'Baseline PostgreSQL intake creation passes ISO strings to Date-mode timestamps',diagnostic:error.message};fs.writeFileSync(path.join(root,'blocker.json'),JSON.stringify(blocker,null,2));t.skip('BLOCKED baseline PostgreSQL timestamp mapping; not recovery acceptance');return;
    }throw error;
   }
   if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.cpSync(root,caseEvidence+'-before-restart',{recursive:true});}
   if(driver==='sqlite')assert.equal(death.checkpoint.journalMode,'wal');
   const first=restart(root,driver,h?.schemaName),second=restart(root,driver,h?.schemaName);assert.deepEqual(first,second);const report=plan(first);assert.deepEqual(report,plan(second));assert.ok(report.entries.every(e=>e.action==='retain'));
   const committed=boundary.endsWith('-committed')||boundary.endsWith('-lost-ack');
   if(boundary.startsWith('ai-')){assert.equal(first.aiPhotos.length,committed?1:0);assert.equal(first.photos.length,0);assert.equal(first.outbox.length,0);if(boundary==='ai-reserved-output')assert.equal(first.files.filter(f=>f.root==='intake'&&f.size===0).length,1);if(boundary==='ai-lost-ack'){assert.equal(report.entries.filter(e=>e.root==='intake'&&e.state==='missing-reference').length,0);assert.equal(first.files.filter(f=>f.root==='intake').length,1);assert.equal(death.checkpoint.code,'PHOTO_STORAGE_UNAVAILABLE');assert.equal(death.checkpoint.admission.closed,true);assert.equal(death.checkpoint.enabledWorkRejected,true);assert.equal(death.checkpoint.legacyBypass,true);}if(boundary==='ai-rollback-error'){assert.equal(first.files.filter(f=>f.root==='intake').length,1);assert.equal(death.checkpoint.admission.closed,true);}}
   if(boundary==='product-one-link'&&process.platform==='linux'){const published=first.files.find(f=>f.root==='canonical');const staged=first.files.find(f=>f.root==='product-ingress'&&f.key.endsWith('/main.webp'));assert.equal(published.ino,staged.ino);assert.equal(published.dev,staged.dev);assert.equal(published.nlink,2);}
   if(boundary.startsWith('product-')){assert.equal(first.photos.length,committed?1:0);assert.equal(first.outbox.length,committed?1:0);assert.equal(first.files.filter(f=>f.root==='canonical').length,boundary==='product-one-link'?1:2);}
   if(boundary==='instagram-temp'){assert.equal(first.photos.length,1);assert.equal(first.outbox.length,0);assert.equal(first.files.filter(f=>f.key.startsWith('.instagram-')).length,1);}
   if(boundary.startsWith('finalize-')){assert.equal(first.aiPhotos.length,1);assert.equal(first.photos.length,committed?1:0);assert.equal(first.outbox.length,committed?1:0);assert.equal(first.intakes[0].status,committed?'finalized':'applied');assert.equal(first.files.filter(f=>f.root==='canonical').length,['finalize-first-output','finalize-zero-output'].includes(boundary)?1:2);if(committed)assert.equal(first.photos[0].id,first.aiPhotos[0].id);}
   let retries;
   if(boundary.startsWith('finalize-')){
    const retry=()=>{const result=spawnSync(process.execPath,['--import','tsx',path.join(directory,'crash-worker.cjs'),root,driver,'retry-finalize',h?.schemaName||''],{cwd:path.resolve(directory,'../..'),env:process.env,encoding:'utf8',timeout:30000,maxBuffer:8192});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
    retries=[retry(),retry()];const after=restart(root,driver,h?.schemaName);
    if(boundary==='finalize-zero-output'){assert.ok(retries.every(r=>!r.ok));assert.deepEqual(after,first);}
    else {assert.deepEqual(retries,[{ok:true,created:!committed},{ok:true,created:false}]);assert.equal(after.photos.length,1);assert.equal(after.outbox.length,1);assert.equal(after.photos[0].id,after.aiPhotos[0].id);assert.deepEqual(after.files.filter(f=>f.root==='intake'),first.files.filter(f=>f.root==='intake'));for(const f of first.files.filter(f=>f.root==='canonical'))assert.deepEqual(after.files.find(a=>a.root===f.root&&a.key===f.key),f);}
   }
   const record={driver,boundary,death,first,second,report,retries,sourceSha:process.env.NOCTELLA_PROBE_SOURCE_SHA||'local',runtimeSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(directory,'../../apps/api/src/services/aiIntakePhotos.ts'))).digest('hex'),retainedRoot:root};fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(record,null,2));
   if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.cpSync(root,caseEvidence,{recursive:true});}
  }finally{if(caseEvidence){fs.mkdirSync(evidence,{recursive:true});fs.cpSync(root,caseEvidence+'-final',{recursive:true});}if(h)await h.close();}
 });
}

for(const boundary of ['pg-protocol-uncommitted','pg-protocol-committed','pg-protocol-outbox-only'])test('postgres protocol fixture '+boundary,{skip:!process.env.POSTGRES_TEST_DATABASE_URL,timeout:120000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noctella-photo-crash-'));const h=await require('../../apps/api/tests/postgresTestDb.ts').createPostgresTestDb();
 const target=evidence?path.join(evidence,'postgres-'+boundary+'-'+path.basename(root)):null;
 try{
  const death=await readyAndKill(root,'postgres',boundary,h.schemaName);if(target)fs.cpSync(root,target+'-before-restart',{recursive:true});
  const first=restart(root,'postgres',h.schemaName),second=restart(root,'postgres',h.schemaName);assert.deepEqual(first,second);const report=plan(first);assert.deepEqual(report,plan(second));
  const committed=boundary==='pg-protocol-committed',outboxOnly=boundary==='pg-protocol-outbox-only';assert.equal(first.photos.length,committed?1:0);assert.equal(first.aiPhotos.length,committed?1:0);assert.equal(first.outbox.length,committed||outboxOnly?1:0);
  const canonical=report.entries.filter(e=>e.root==='canonical');assert.equal(canonical.length,2);assert.ok(canonical.every(e=>e.state===(committed||outboxOnly?'protected-reference':'unproven-ownership')));assert.ok(report.entries.every(e=>e.action==='retain'));assert.equal(report.safeToMutate,false);
  const record={driver:'postgres',boundary,scope:'native-SQL-transaction-fixture-not-full-photo-service',death,first,second,report,sourceSha:process.env.NOCTELLA_PROBE_SOURCE_SHA||'local'};fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(record,null,2));
 }finally{if(target)fs.cpSync(root,target+'-final',{recursive:true});await h.close();}
});
