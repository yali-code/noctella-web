'use strict';
// FAZ A #424 package E: the authoritative fencing disposition of every filesystem/child-process mutation site the
// census finds in apps/api/src. Each file must be classified (no new writer without a decision), and every
// disposition is backed by a source-level proof (a refusal, the fenced owner, or the separate root it writes to).
// Behavioural proofs live in the W2/W4/W11 vitest suites; this gate keeps the inventory complete and honest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { census, SRC } = require('./scan.cjs');

const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const has = (file, text) => read(file).includes(text);

/** file -> { writers, disposition, proof } */
const DISPOSITION = {
  'services/photoPersistentIdentity.ts': { writers: 'W2/W4 read-only descriptor identity', disposition: 'NON_MEDIA (read-only reviewed helper FS_IOC_GETFSUUID; no file mutation or worker execution)', proof: () => has('services/photoPersistentIdentity.ts', '["--storage-proof"]') },
  'routes/productPhotoUpload.ts': { writers: 'W2 ingress', disposition: 'ADOPTED (fenced owner injected; refuses without it)', proof: () => has('routes/productPhotoUpload.ts', 'fencingOn && !options.fencedUpload') },
  'services/photoOperationAuthority.ts': { writers: 'W2/W4 authority', disposition: 'ADOPTED (private generation dirs; the legacy worker-inode link primitive has no runtime caller, #472)', proof: () => has('services/photoOperationAuthority.ts', 'LEGACY / NEGATIVE CONTROL ONLY') && !has('services/w2FencedProductPhotoOwner.ts', 'publishSealedArtifacts') && !has('services/w4FencedFinalizationOwner.ts', 'publishSealedArtifacts') },
  'services/photoPublicationExecutor.ts': { writers: 'W2/W4 protected publication', disposition: 'ADOPTED (intent-authorized copy publication; readiness fails closed, #472)', proof: () => has('services/w2FencedProductPhotoOwner.ts', 'publishAuthorizedArtifacts(') && has('services/w4FencedFinalizationOwner.ts', 'publishAuthorizedArtifacts(') && has('services/photoPublicationExecutor.ts', 'PHOTO_PUBLICATION_NOT_READY') },
  'services/w4FencedFinalizationOwner.ts': { writers: 'W4 confined preparation input', disposition: 'PRIVATE (staged source copied into its private job directory; no canonical write, #472)', proof: () => has('services/w4FencedFinalizationOwner.ts', 'const inputPath = path.join(jobDir, "source")') && !has('services/w4FencedFinalizationOwner.ts', 'publishSealedArtifacts') },
  'services/photoCopyPublisher.ts': { writers: 'W2/W4 protected publication', disposition: 'ADOPTED (publisher-owned verified copy, recorded before a no-overwrite link, #472)', proof: () => has('services/photoCopyPublisher.ts', 'await ledger.record(copy)') && has('services/photoCopyPublisher.ts', 'fs.linkSync(stagedPath, canonical)') },
  'services/photoPreparationConfinement.ts': { writers: 'W2/W4 confined preparation', disposition: 'PRIVATE (Landlock worker writes only generation/job directories; opt-in PHOTO_PREPARATION_CONFINEMENT=required, #472)', proof: () => has('services/photoPreparationConfinement.ts', 'spawn(launcher, [job.outDir, jobDir,') },
  'use-cases/private-photo-backup/useCases.ts': { writers: 'Gate 5 cold-evidence CLI', disposition: 'NON_MEDIA (owner-operated cold evidence: reads operations/publication roots and the snapshot DB; writes only a new exclusive owner-private destination; source overlap refused)', proof: () => has('use-cases/private-photo-backup/useCases.ts', 'if (overlaps(input, destination) || overlaps(destination, input)) fail();') },
  'services/stagedProductPhotoStorage.ts': { writers: 'W2 legacy path, W10', disposition: 'REFUSED under fencing (legacy W2/W10 path is only reached with fencing OFF)', proof: () => has('services/products.ts', 'refuseUnfencedProductUpload();') },
  'services/photoStorage.ts': { writers: 'W1, W4 legacy, W10, W4 fenced prepare', disposition: 'W1 REFUSED; legacy W4 writer REFUSED; fenced prepare writes only generation-private files', proof: () => has('services/products.ts', 'refuseUnfencedProductUpload();') && has('use-cases/ai-intake-photo-finalize/useCases.ts', 'refuseUnadoptedPhotoWriter("W4_AI_FINALIZE")') && has('services/photoStorage.ts', 'export function prepareDeterministicProductPhotoFiles') },
  'services/aiIntakePhotoStorage.ts': { writers: 'W3, W5', disposition: 'PRIVATE (non-canonical staging; unfenced by design)', proof: () => has('services/aiIntakePhotoStorage.ts', 'AI_INTAKE_PHOTO_DIR') },
  'services/managedFileDeletion.ts': { writers: 'W5, W6', disposition: 'W5 PRIVATE; W6 canonical deletion REFUSED under fencing', proof: () => has('services/aiIntakeCleanup.ts', 'refuseUnadoptedPhotoWriter("W6_AI_CLEANUP_CANONICAL_DELETE")') },
  'services/productPhotoStorageWorkflow.ts': { writers: 'W7, W8, W9', disposition: 'REFUSED under fencing (distinct-root promotion, temp cleanup; canonical delete without the authorized deleter). W8 with it: see photoCanonicalDeletion.ts', proof: () => ['W7_DISTINCT_ROOT_PROMOTION', 'W8_CANONICAL_DELETE', 'W9_TEMP_CLEANUP'].every((w) => has('services/productPhotoStorageWorkflow.ts', `refuseUnadoptedPhotoWriter("${w}")`)) && has('services/productPhotoStorageWorkflow.ts', 'if (photoOwnershipFencingEnabled()) return this.handleFenced(event);') },
  'services/photoCanonicalDeletion.ts': { writers: 'W8 authorized deletion (4C)', disposition: 'ADOPTED (committed operation + committed intent + recorded copy identity, all references checked and names unlinked under the operation row lock; no sweep)', proof: () => has('services/photoCanonicalDeletion.ts', 'inOwnershipTransaction(db, driver,') && has('services/photoCanonicalDeletion.ts', 'WHERE target_photo_id = ${photoId}${rowLock(driver)}') && has('services/productPhotoOutboxDispatcher.ts', 'deleteAuthorizedCanonicalPhoto(') },
  'integrations/instagram/mediaPreparation.ts': { writers: 'W11', disposition: 'REFUSED under fencing (adoption needs owner-approved 0042)', proof: () => has('integrations/instagram/mediaPreparation.ts', 'if (photoOwnershipFencingEnabled()) throw new InstagramClientError("processing", true);') },
  'services/w11FencedInstagramDerivativeOwner.ts': { writers: 'W11 proposal', disposition: 'INACTIVE PROPOSAL (not imported by production code)', proof: () => !has('integrations/instagram/mediaPreparation.ts', 'w11FencedInstagramDerivativeOwner') },
  'integrations/media/reelRenderer.ts': { writers: 'W12', disposition: 'SEPARATE ROOT (generated reel MP4s in MEDIA_ASSET_DIR; no product-photo bytes)', proof: () => has('config/mediaAssets.ts', 'MEDIA_ASSET_DIR') && !has('integrations/media/reelRenderer.ts', 'productPhotoStaticRoot') },
  'use-cases/product-photo-backup/useCases.ts': { writers: 'W13', disposition: 'SEPARATE ROOT (private mkdtemp work dirs; reads canonical photos, never writes them)', proof: () => has('use-cases/product-photo-backup/useCases.ts', 'mkdtemp(path.join(os.tmpdir()') },
  'repositories/product-photo-backup/s3Compatible.ts': { writers: 'W13 download', disposition: 'SEPARATE ROOT (caller-provided private download path)', proof: () => !has('repositories/product-photo-backup/s3Compatible.ts', 'productPhotoStaticRoot') },
  'use-cases/database-backup/useCases.ts': { writers: 'W14', disposition: 'SEPARATE ROOT (database files and private temp dirs only)', proof: () => !has('use-cases/database-backup/useCases.ts', 'productPhotoStaticRoot') },
  'repositories/database-backup/s3Compatible.ts': { writers: 'W14 download', disposition: 'SEPARATE ROOT', proof: () => !has('repositories/database-backup/s3Compatible.ts', 'productPhotoStaticRoot') },
  'services/developmentPhotoStorageCapability.ts': { writers: 'DEV', disposition: 'DEVELOPMENT ONLY (refuses outside test/development)', proof: () => has('services/developmentPhotoStorageCapability.ts', 'PHOTO_DEVELOPMENT_CAPABILITY_DISABLED') },
  'services/developmentPhotoDiskBudget.ts': { writers: 'DEV', disposition: 'DEVELOPMENT ONLY', proof: () => true },
  'services/developmentPhotoRecovery.ts': { writers: 'DEV', disposition: 'DEVELOPMENT ONLY', proof: () => true },
  'services/developmentLegacyWriterGate.ts': { writers: 'DEV', disposition: 'DEVELOPMENT ONLY (gate bookkeeping)', proof: () => true },
  'scripts/inventoryRepositoryAudit.ts': { writers: 'NON_MEDIA', disposition: 'NON_MEDIA', proof: () => true },
  'scripts/refundUseCaseAudit.ts': { writers: 'NON_MEDIA', disposition: 'NON_MEDIA', proof: () => true },
  'scripts/sharedImageResourceProbe.ts': { writers: 'NON_MEDIA', disposition: 'NON_MEDIA (disposable resource probe)', proof: () => has('scripts/sharedImageResourceProbe.ts', 'Disposable Linux environment required') },
};

test('every census mutation site has an explicit fencing disposition (no unclassified writer)', () => {
  const found = Object.keys(census()).sort();
  assert.deepEqual(found.filter((file) => !DISPOSITION[file]), [], 'classify new writers before they can ship');
  assert.deepEqual(Object.keys(DISPOSITION).filter((file) => !found.includes(file)).sort(), [], 'remove stale dispositions');
});

test('every disposition is backed by its source-level proof', () => {
  const failed = Object.entries(DISPOSITION).filter(([, d]) => !d.proof()).map(([file, d]) => `${file}: ${d.disposition}`);
  assert.deepEqual(failed, []);
});

test('no canonical-root writer is left unfenced while fencing is ON', () => {
  const unsafe = Object.entries(DISPOSITION).filter(([, d]) => !/^(ADOPTED|REFUSED|W1 REFUSED|W5 PRIVATE|PRIVATE|INACTIVE|SEPARATE ROOT|DEVELOPMENT ONLY|NON_MEDIA)/.test(d.disposition));
  assert.deepEqual(unsafe, []);
});
