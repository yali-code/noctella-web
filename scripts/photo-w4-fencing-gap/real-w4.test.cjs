'use strict';
// Disposable-only real-use-case counterexample. This is NOT a safe W4 adoption test.
const test = require('node:test');
const assert = require('node:assert/strict');

test('real W4 manifest preparation still invokes canonical writer while ownership switch ON', async () => {
  const prior = process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
  try {
    process.env.PHOTO_OWNERSHIP_FENCING_ENABLED = 'true';
    const {photoOwnershipFencingEnabled} = await import('../../apps/api/src/services/photoOwnershipFencing.ts');
    const {buildAiIntakePhotoFinalizationManifest} = await import('../../apps/api/src/use-cases/ai-intake-photo-finalize/useCases.ts');
    assert.equal(photoOwnershipFencingEnabled(), true);
    let attempts = 0;
    const rows = await buildAiIntakePhotoFinalizationManifest({
      readStagedPhotoBytes: async () => Buffer.from('disposable-source-bytes'),
      writeDeterministicPhoto: async (input) => {
        attempts++;
        assert.equal(input.mainStorageKey,'product-test-staged-test.webp');
        assert.equal(input.thumbnailStorageKey,'product-test-staged-test-thumb.webp');
        return {
          mainStorageKey:input.mainStorageKey, thumbnailStorageKey:input.thumbnailStorageKey,
          url:'/images/product-photos/'+input.mainStorageKey,
          thumbnailUrl:'/images/product-photos/'+input.thumbnailStorageKey,
          mimeType:'image/webp',sizeBytes:24,width:2,height:2
        };
      }
    },[{id:'staged-test',storageKey:'private-test.webp'}],'product-test',undefined);
    assert.equal(attempts,1,'Known security gap: W4 is still not gated at real manifest writer boundary');
    assert.equal(rows.length,1);
  } finally {
    if(prior === undefined) delete process.env.PHOTO_OWNERSHIP_FENCING_ENABLED;
    else process.env.PHOTO_OWNERSHIP_FENCING_ENABLED=prior;
  }
});
