'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {classify} = require('./identity.cjs');
const base = {tenantId:'org1',actorId:'admin1',productId:'photo1',kind:'W2',token:'repeatable-123456',sha256:'a'.repeat(64),altText:'Back view'};
test('first intent is new and exact retry matches',()=>{
  assert.equal(classify(null,base),'NEW');
  assert.equal(classify(base,{...base}),'SAME_INTENT');
});
for (const field of Object.keys(base)) {
  test('changed '+field+' must conflict',()=>assert.equal(classify(base,{...base,[field]:'different'}),'CONFLICT'));
}
test('missing scope is invalid',()=>assert.equal(classify(null,{...base,tenantId:''}),'INVALID'));
test('missing incoming intent invalid',()=>assert.equal(classify(null,null),'INVALID'));
test('unknown stored identity is a conflict',()=>assert.equal(classify({},base),'CONFLICT'));
