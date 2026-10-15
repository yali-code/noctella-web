'use strict';
// Real W4 boundary proof, using only mocked bytes/writers and no filesystem or DB.
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildAiIntakePhotoFinalizationManifest}=require('../../apps/api/src/use-cases/ai-intake-photo-finalize/useCases.ts');
const {photoOwnershipFencingEnabled}=require('../../apps/api/src/services/photoOwnershipFencing.ts');
const {finalizeAiIntakePhotosUseCase}=require('../../apps/api/src/use-cases/ai-intake-photo-finalize/useCases.ts');
const {AiProductIntakeStatus}=require('@noctella/shared');

test('W4 ON refuses before reading bytes or invoking canonical writer',async()=>{
  const prior=process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
  try {
    process.env.PHOTO_OWNERSHIP_FENCING_ENABLED='true';
    assert.equal(photoOwnershipFencingEnabled(),true);
    let reads=0,writes=0;
    await assert.rejects(
      buildAiIntakePhotoFinalizationManifest({
        readStagedPhotoBytes:async()=>{reads++;return Buffer.from('data');},
        writeDeterministicPhoto:async()=>{writes++;throw Error('MUST_NOT_WRITE');}
      },[{id:'staged-test',storageKey:'private-test.webp'}],'product-test',undefined),
      {code:'PHOTO_FENCING_WRITER_NOT_ADOPTED',writer:'W4_AI_FINALIZE'}
    );
    assert.equal(reads,0);assert.equal(writes,0);
  } finally {
    if(prior===undefined)delete process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
    else process.env.PHOTO_OWNERSHIP_FENCING_ENABLED=prior;
  }
});
test('W4 OFF retains legacy manifest generation without changing file behavior',async()=>{
  const prior=process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
  try {
    process.env.PHOTO_OWNERSHIP_FENCING_ENABLED='false';
    let writes=0;
    const result=await buildAiIntakePhotoFinalizationManifest({
      readStagedPhotoBytes:async()=>Buffer.from('test'),
      writeDeterministicPhoto:async input=>{writes++;return {
        mainStorageKey:input.mainStorageKey,thumbnailStorageKey:input.thumbnailStorageKey,
        url:'/images/product-photos/'+input.mainStorageKey,
        thumbnailUrl:'/images/product-photos/'+input.thumbnailStorageKey,
        mimeType:'image/webp',sizeBytes:4,width:2,height:2
      };}
    },[{id:'staged-test',storageKey:'private-test.webp'}],'product-test',undefined);
    assert.equal(writes,1);assert.equal(result.length,1);assert.equal(result[0].productPhotoId,'staged-test');
  } finally {
    if(prior===undefined)delete process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
    else process.env.PHOTO_OWNERSHIP_FENCING_ENABLED=prior;
  }
});

test('W4 ON refuses Applied transaction before touching product/photo/outbox adapters',async()=>{
  const prior=process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
  try{
    process.env.PHOTO_OWNERSHIP_FENCING_ENABLED='true';
    let touched=0;
    const cap={runWithLockedIntake:async(_id,cb)=>cb({
      intake:{status:AiProductIntakeStatus.Applied,resultProductId:'product-test'},
      lockProduct:()=>{touched++;throw Error('MUST_NOT_TOUCH');}
    })};
    await assert.rejects(finalizeAiIntakePhotosUseCase(cap,{
      intakeId:'intake-test',actorId:'actor-test',manifest:[]
    }),{code:'PHOTO_FENCING_WRITER_NOT_ADOPTED',writer:'W4_AI_FINALIZE'});
    assert.equal(touched,0);
  }finally{
    if(prior===undefined)delete process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
    else process.env.PHOTO_OWNERSHIP_FENCING_ENABLED=prior;
  }
});
