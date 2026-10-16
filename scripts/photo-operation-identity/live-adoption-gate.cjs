'use strict';
// FAZ A / #424 supplementary wiring check for W2 live adoption. Source evidence alone is NOT adoption:
// the required gate is the behavioural CI step (tests/w2LiveFencedAdoptionRoute.test.ts and
// tests/w2FencedOwnerRecovery.test.ts on SQLite and real PostgreSQL). This only proves the production router
// injects the real generation-fenced owner and that the owner commits through the fenced transaction.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const router = read('apps/api/src/routes/products.ts');
const handler = read('apps/api/src/routes/productPhotoUpload.ts');
const owner = read('apps/api/src/services/w2FencedProductPhotoOwner.ts');
const evidence = {
  routerInjectsFencedOwner: /fencedUpload:\s*command\s*=>\s*uploadFencedProductPhoto\(db,\s*command\)/.test(router),
  handlerRefusesWithoutOwner: /fencingOn && !options\.fencedUpload/.test(handler),
  handlerDigestsBeforeOwner: /digestW2StagedInput\(file/.test(handler) && /options\.fencedUpload!\(/.test(handler),
  ownerBindsIntentToOperation: /INSERT INTO photo_w2_upload_intents[\s\S]*operation_id/.test(owner),
  ownerCommitsThroughFencedTransaction: /persistFencedUploadedProductPhoto\(/.test(owner),
  ownerNeverOverwrites: /await link\(file, destination\)/.test(owner) && !/rename\(|copyFile\(|writeFile\(/.test(owner),
};
console.log(JSON.stringify({ gate: 'W2_LIVE_ADOPTION_WIRING', evidence }, null, 2));
if (!Object.values(evidence).every(Boolean)) {
  console.error('BLOCKED: the production W2 route is not wired to the generation-fenced owner.');
  process.exitCode = 1;
}
