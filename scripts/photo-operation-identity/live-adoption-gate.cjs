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
const w11Live = read('apps/api/src/integrations/instagram/mediaPreparation.ts');
const srcFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? srcFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
const importsW11Proposal = srcFiles(path.join(root, 'apps/api/src')).filter((file) => /w11FencedInstagramDerivativeOwner/.test(fs.readFileSync(file, 'utf8')) && !file.endsWith('w11FencedInstagramDerivativeOwner.ts'));
const evidence = {
  routerInjectsFencedOwner: /fencedUpload:\s*command\s*=>\s*uploadFencedProductPhoto\(db,\s*command\)/.test(router),
  handlerRefusesWithoutOwner: /fencingOn && !options\.fencedUpload/.test(handler),
  handlerDigestsBeforeOwner: /digestW2StagedInput\(file/.test(handler) && /options\.fencedUpload!\(/.test(handler),
  w2BindsIntentToOperation: /INSERT INTO photo_w2_upload_intents[\s\S]*operation_id/.test(owner),
  w2CommitsThroughFencedTransaction: /persistFencedUploadedProductPhoto\(/.test(owner),
  // The only owner-side write is W4's exclusive (wx) confined-preparation input inside its private job directory (#472).
  authorityNeverOverwrites: /await link\(file, destination\)/.test(authority) && !/rename\(|copyFile\(/.test(authority + owner + w4Owner)
    && !/writeFile\((?!inputPath, bytes, \{ flag: "wx", mode: 0o600 \}\))/.test(authority + owner + w4Owner),
  w4ServiceUsesFencedOwnerWhenFencingOn: /photoOwnershipFencingEnabled\(\)[\s\S]*buildFencedAiIntakePhotoFinalizationManifest\(/.test(w4Service),
  // Stage 5 F2 (#472): W2 and W4 seal through the shared authority, then publish only through the protected,
  // intent-authorized copy publisher; the legacy worker-inode link primitive is never called by either owner.
  w4OwnerUsesSharedAuthority: /sealPreparedArtifacts\(/.test(w4Owner) && /acquirePublicationIntent\(/.test(w4Owner) && /publishAuthorizedArtifacts\(/.test(w4Owner),
  ownersUseProtectedPublication: [owner, w4Owner].every((s) => /assertPhotoPublicationReady\(/.test(s) && /guardedReclaimSteps\(/.test(s) && /acquirePublicationIntent\(/.test(s) && /publishAuthorizedArtifacts\(/.test(s) && !/publishSealedArtifacts/.test(s)),
  w4TransactionCommitsFence: /ctx\.commitPhotoOperation\(/.test(w4UseCase) && /commitPhotoOperation: \(proof\) => commitDrizzlePhotoOperationFenced\(tx, execution, proof\)/.test(w4Capability),
  w4RefusesUnprovenManifest: /entry\.fence\)\)\) refuseUnadoptedPhotoWriter\("W4_AI_FINALIZE"\)/.test(w4UseCase),
  // W11 is NOT adopted: the live writer still refuses under fencing and the proposal owner is not wired anywhere.
  w11LiveStillRefusesUnderFencing: w11Live.includes('if (photoOwnershipFencingEnabled()) throw new InstagramClientError("processing", true);'),
  w11ProposalNotWired: importsW11Proposal.length === 0,
};
console.log(JSON.stringify({ gate: 'W2_W4_LIVE_ADOPTION_WIRING', evidence }, null, 2));
if (!Object.values(evidence).every(Boolean)) {
  console.error('BLOCKED: the production W2 route or W4 finalization is not wired to the generation-fenced authority.');
  process.exitCode = 1;
}
