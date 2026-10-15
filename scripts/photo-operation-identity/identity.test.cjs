'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {classify} = require('./identity.cjs');
const base = Object.freeze({tenantId:'org1',actorId:'admin1',productId:'photo1',kind:'W2_PRODUCT_PHOTO_UPLOAD',token:'repeatable-123456',sha256:'a'.repeat(64),altText:'Back view'});
test('new and identical intent only',()=> {
  assert.equal(classify(null,base),'NEW');
  assert.equal(classify(base,{...base}),'SAME_INTENT');
});
const changed = {tenantId:'org2',actorId:'admin2',productId:'photo2',token:'other-repeatable-1234',sha256:'b'.repeat(64),altText:'Front view'};
for(const [field,value] of Object.entries(changed)) {
  test('reject changed '+field,()=>assert.equal(classify(base,{...base,[field]:value}),'CONFLICT'));
}
test('invalid new intent never admitted',()=> {
  const invalid=[null,[],{}, {...base,tenantId:'../outside'}, {...base,actorId:''}, {...base,kind:'W4'}, {...base,token:'short'}, {...base,token:'x'.repeat(129)}, {...base,sha256:'A'.repeat(64)}, {...base,sha256:'a'.repeat(63)}, {...base,altText:null}, {...base,altText:'x'.repeat(501)}];
  for(const value of invalid) assert.equal(classify(null,value),'INVALID');
});
test('invalid persisted state conservatively conflicts',()=> {
  assert.equal(classify({},base),'CONFLICT');
  assert.equal(classify({...base,sha256:'invalid'},base),'CONFLICT');
});
test('no mutation or result data exposure',()=> {
  const requested={...base};const copy={...requested};
  assert.equal(classify(base,requested),'SAME_INTENT');
  assert.deepEqual(requested,copy);
});
