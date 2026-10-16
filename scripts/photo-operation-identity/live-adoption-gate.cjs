'use strict';
// FAZ A / #424 supplementary wiring check for W2 and W4 live adoption. Source evidence alone is NOT adoption:
// the required gate is the behavioural CI step (tests/w2LiveFencedAdoptionRoute.test.ts,
// tests/w2FencedOwnerRecovery.test.ts and tests/w4FencedFinalizationAcceptance.test.ts on SQLite and real
// PostgreSQL). This only proves the production paths are wired to the shared generation-fenced authority.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const router = read('apps/api/src/routes/products.ts');
const handler = read('apps/api/src/routes/productPhotoUpload.ts');
const owner = read('apps/api/src/services/w2FencedProductPhotoOwner.ts');
const authority = read('apps/api/src/services/photoOperationAuthority.ts');
const w4Service = read('apps/api/src/services/aiIntakePhotoFinalization.ts');
const w4Owner = read('apps/api/src/services/w4FencedFinalizationOwner.ts');
const w4UseCase = read('apps/api/src/use-cases/ai-intake-photo-finalize/useCases.ts');
const w4Capability = read('apps/api/src/services/aiIntakePhotoFinalizeTransactionCapabilityForDb.ts');
const evidence = {
  routerInjectsFencedOwner: /fencedUpload:\s*command\s*=>\s*uploadFencedProductPhoto\(db,\s*command\)/.test(router),
  handlerRefusesWithoutOwner: /fencingOn && !options\.fencedUpload/.test(handler),
  handlerDigestsBeforeOwner: /digestW2StagedInput\(file/.test(handler) && /options\.fencedUpload!\(/.test(handler),
  w2BindsIntentToOperation: /INSERT INTO photo_w2_upload_intents[\s\S]*operation_id/.test(owner),
  w2CommitsThroughFencedTransaction: /persistFencedUploadedProductPhoto\(/.test(owner),
  authorityNeverOverwrites: /await link\(file, destination\)/.test(authority) && !/rename\(|copyFile\(|writeFile\(/.test(authority + owner + w4Owner),
  w4ServiceUsesFencedOwnerWhenFencingOn: /photoOwnershipFencingEnabled\(\)[\s\S]*buildFencedAiIntakePhotoFinalizationManifest\(/.test(w4Service),
  w4OwnerUsesSharedAuthority: /publishSealedArtifacts\(/.test(w4Owner) && /sealPreparedArtifacts\(/.test(w4Owner),
  w4TransactionCommitsFence: /ctx\.commitPhotoOperation\(/.test(w4UseCase) && /commitPhotoOperation: \(proof\) => commitDrizzlePhotoOperationFenced\(tx, execution, proof\)/.test(w4Capability),
  w4RefusesUnprovenManifest: /entry\.fence\)\)\) refuseUnadoptedPhotoWriter\("W4_AI_FINALIZE"\)/.test(w4UseCase),
};
console.log(JSON.stringify({ gate: 'W2_W4_LIVE_ADOPTION_WIRING', evidence }, null, 2));
if (!Object.values(evidence).every(Boolean)) {
  console.error('BLOCKED: the production W2 route or W4 finalization is not wired to the generation-fenced authority.');
  process.exitCode = 1;
}
