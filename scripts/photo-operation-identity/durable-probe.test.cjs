'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {store}=require('./durable-probe.cjs');
const intent=Object.freeze({tenantId:'org1',actorId:'admin1',productId:'product1',kind:'W2_PRODUCT_PHOTO_UPLOAD',token:'repeatable-123456',sha256:'a'.repeat(64),altText:'Back view'});
function fixture() {return fs.mkdtempSync(path.join(os.tmpdir(),'noctella-w2-proof-'));}
test('two SQLite connections: one claim; retry returns same committed row/outbox after reopen (lost HTTP ack)',()=>{
 const root=fixture();let a,b;
 try {
  a=store(root);b=store(root);
  assert.deepEqual(a.claim(intent,100,60),{status:'NEW',generation:1});
  assert.deepEqual(b.claim(intent,101,60),{status:'IN_PROGRESS',generation:1});
  a.commit(intent,1,'photo1','event1');
  a.close();a=null;
  assert.deepEqual(b.claim(intent,102,60),{status:'COMMITTED',photoId:'photo1',outboxId:'event1'});
  assert.equal(b.snapshot().photos.length,1);
  assert.equal(b.snapshot().outbox.length,1);
  b.close();b=null;
  const restart=store(root);
  try {
   assert.deepEqual(restart.claim(intent,110,60),{status:'COMMITTED',photoId:'photo1',outboxId:'event1'});
   assert.equal(restart.snapshot().operations.length,1);
   assert.equal(restart.snapshot().photos.length,1);
   assert.equal(restart.snapshot().outbox.length,1);
  } finally {restart.close();}
 } finally {a?.close();b?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('same token with changed scope, input or alt text never mutates published result',()=>{
 const root=fixture(),s=store(root);
 try {
  assert.equal(s.claim(intent,100,50).status,'NEW');
  s.commit(intent,1,'photo1','event1');
  const before=s.snapshot();
  for(const patch of [{tenantId:'other'},{actorId:'other'},{productId:'other'},{sha256:'b'.repeat(64)},{altText:'Changed'}]){
   assert.deepEqual(s.claim({...intent,...patch},101,50),{status:'CONFLICT'});
  }
  assert.deepEqual(s.snapshot(),before);
 } finally {s.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('expired lease generation reclaim refuses stale completion and preserves the new generation',()=>{
 const root=fixture(),s=store(root);
 try {
  assert.equal(s.claim(intent,100,20).generation,1);
  assert.deepEqual(s.reclaim(intent,1,119,20),{status:'RETAIN'});
  assert.deepEqual(s.reclaim(intent,1,120,20),{status:'RECLAIMED',generation:2});
  assert.throws(()=>s.commit(intent,1,'stalephoto','staleevent'),/STALE_FENCE/);
  assert.equal(s.snapshot().photos.length,0);
  s.commit(intent,2,'photo2','event2');
  assert.equal(s.snapshot().photos[0].id,'photo2');
  assert.equal(s.snapshot().outbox[0].id,'event2');
 } finally {s.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('SQL uniqueness aborts the complete photo/outbox transaction without partial commit',()=>{
 const root=fixture(),s=store(root);
 try {
  assert.equal(s.claim(intent,100,100).status,'NEW');
  s.commit(intent,1,'photo1','event1');
  const second={...intent,token:'other-repeatable-123456'};
  assert.equal(s.claim(second,101,100).status,'NEW');
  assert.throws(()=>s.commit(second,1,'photo1','event2'));
  assert.equal(s.read(second.token).state,'receiving');
  assert.deepEqual(s.snapshot().photos.map(x=>x.id),['photo1']);
  assert.deepEqual(s.snapshot().outbox.map(x=>x.id),['event1']);
 } finally {s.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('invalid roots and malformed tokens fail closed',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'other-test-'));
 try{assert.throws(()=>store(root),/DISPOSABLE_ROOT_REQUIRED/);}finally{fs.rmSync(root,{recursive:true,force:true});}
 const safe=fixture(),s=store(safe);
 try{assert.throws(()=>s.claim({...intent,token:'short'},1,1),/INVALID_INTENT/);}finally{s.close();fs.rmSync(safe,{recursive:true,force:true});}
});
