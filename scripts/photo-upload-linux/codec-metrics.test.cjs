const test=require('node:test');
const assert=require('node:assert/strict');
const {compareSamples}=require('./codec-metrics.cjs');
test('bit-identical decoded image has zero error and infinite PSNR',()=>{
 assert.deepEqual(compareSamples(Buffer.from([0,128,255]),Buffer.from([0,128,255])),{decodedSampleCount:3,differingSamples:0,maxAbsoluteError:0,mse:0,psnrDb:'infinite',decodedIdentical:true});
});
test('lossy changes cannot be reported identical and use all channel samples',()=>{
 const result=compareSamples(Buffer.from([0,10,255,50]),Buffer.from([3,10,251,50]));
 assert.equal(result.differingSamples,2);assert.equal(result.maxAbsoluteError,4);assert.equal(result.mse,6.25);assert.equal(result.decodedIdentical,false);assert.ok(Math.abs(result.psnrDb-40.1720034352)<1e-9);
});
test('incomplete or absent pixel arrays fail closed',()=>{
 assert.throws(()=>compareSamples(Buffer.alloc(0),Buffer.alloc(0)));
 assert.throws(()=>compareSamples(Buffer.alloc(3),Buffer.alloc(2)));
});
