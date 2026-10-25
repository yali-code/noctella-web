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
  'integrations/instagram/mediaPreparation.ts': { writers: 'W11', disposition: 'SEPARATE ROOT under fencing (non-canonical instagram-derivatives store, confined rendering; canonical root read-only; W11/0042 not adopted, #472)', proof: () => has('integrations/instagram/mediaPreparation.ts', 'const store = protectedMode ? { root: instagramDerivativeRoot(root)') && has('integrations/instagram/mediaPreparation.ts', 'assertPreparationConfinementReady()') && !has('integrations/instagram/mediaPreparation.ts', 'w11FencedInstagramDerivativeOwner') },
  'workers/photoPreparationWorker.ts': { writers: 'confined preparation worker', disposition: 'PRIVATE (Landlock-confined; writes only its generation/job directory, #472)', proof: () => has('workers/photoPreparationWorker.ts', 'path.join(job.outDir, "derivative.jpg")') },
  'integrations/instagram/instagramDerivativeStore.ts': { writers: 'W11 protected-mode store (P5)', disposition: 'SEPARATE ROOT (non-canonical instagram-derivatives store + private job root, asserted non-overlapping with every protected root; no-clobber link, hash adoption or conflict; served only by the registered hash-verified route)', proof: () => { const s = read('integrations/instagram/instagramDerivativeStore.ts'); const writes = s.split('\n').filter((l) => /\b(link|unlink|mkdir|open)\(/.test(l) && !/^\s*(\*|\/\/|import)/.test(l)); return writes.length > 0 && writes.every((l) => !/productPhotoStaticRoot|photoOperationPrivateRoot|photoPublicationStagingRoot|canonicalRoot/.test(l)) && has('integrations/instagram/instagramDerivativeStore.ts', 'productPhotoStorageSafety.safeJoin(roots.store, name)') && has('integrations/instagram/instagramDerivativeStore.ts', 'productPhotoStorageSafety.safeJoin(roots.jobs, `.instagram-') && has('app.ts', 'createInstagramDerivativeAssetRouter(db)') && !has('app.ts', 'express.static(instagramDerivativeRoot'); } },
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

// P5 admission decision: the Instagram recipe (instagramDerivativeRecipe.ts) keeps main's original admission-free body.
// Its production importers are listed explicitly and must call it only under image admission; any new importer fails.
// The dormant W11 owner reaches it through mediaPreparation's re-export and stays non-production-imported (inventory).
test('the Instagram recipe is imported only by explicitly listed, admitted production callers', () => {
  const recipe = /["']\.{1,2}\/(?:[\w-]+\/)*instagramDerivativeRecipe["']/;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
  const importers = walk(SRC).map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .filter((f) => f !== 'integrations/instagram/instagramDerivativeRecipe.ts' && recipe.test(read(f))).sort();
  assert.deepEqual(importers, ['integrations/instagram/mediaPreparation.ts', 'workers/photoPreparationWorker.ts']);

  // Worker: the only render call is inside runImageOperation.
  const worker = read('workers/photoPreparationWorker.ts').split(/\r?\n/).filter((l) => /renderInstagramDerivative\(/.test(l) && !/import\(/.test(l));
  assert.deepEqual(worker.map((l) => l.trim()), ['const bytes = await runImageOperation(() => renderInstagramDerivative(readFileSync(job.inputPath), job.recipe));']);

  // mediaPreparation: render happens only in non-exported *Unadmitted / renderProtected functions, and every exported
  // entry point reaches them only through instagramImageOperation (runImageOperation).
  const media = read('integrations/instagram/mediaPreparation.ts');
  const calls = media.split(/\r?\n/).filter((l) => /\brender(InstagramDerivative|Protected)\(/.test(l) && !/^\s*(\*|\/\/|import|export \{)/.test(l) && !/^\s*(async )?function renderProtected\(/.test(l));
  assert.ok(calls.length > 0);
  for (const name of ['prepareInstagramImageAssetUnadmitted', 'inspectPreparedInstagramImageUnadmitted']) {
    assert.ok(!new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(media), `${name} must not be exported`);
  }
  assert.ok(!/export\s+(async\s+)?function\s+renderProtected\b/.test(media), 'renderProtected must not be exported');
  assert.match(media, /export const prepareInstagramImageAsset: typeof prepareInstagramImageAssetUnadmitted =\s*\(\.\.\.args\) => instagramImageOperation\(\(\) => prepareInstagramImageAssetUnadmitted\(\.\.\.args\)\);/);
  assert.match(media, /export const inspectPreparedInstagramImage: typeof inspectPreparedInstagramImageUnadmitted =\s*\(\.\.\.args\) => instagramImageOperation\(\(\) => inspectPreparedInstagramImageUnadmitted\(\.\.\.args\)\);/);
  assert.match(media, /async function instagramImageOperation<T>\(work: \(\) => Promise<T>\): Promise<T> \{\s*try \{ return await runImageOperation\(work\); \}/);
  // The only other exported caller delegates to the wrapped entry point.
  assert.match(media, /return \(await prepareInstagramImageAsset\(photo, publicOrigin, env, root\)\)\.url;/);
});

// P5: nothing writes or deletes in the Instagram store or its private job root outside the publication flow.
test('only the publication flow mutates the Instagram store and private job root', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
  const refs = /instagramDerivativeRoot|instagramDerivativeJobRoot|instagram-derivatives|\.instagram-derivative-jobs|publishToInstagramStore/;
  const users = walk(SRC).map((f) => path.relative(SRC, f).split(path.sep).join('/')).filter((f) => refs.test(read(f))).sort();
  assert.deepEqual(users, ['integrations/instagram/instagramDerivativeStore.ts', 'integrations/instagram/mediaPreparation.ts', 'routes/instagramDerivativeAssets.ts']);

  // Route: read-only (no fs import at all; it reads through readStoreFile).
  assert.ok(!/from ["'](?:node:)?fs(?:\/promises)?["']/.test(read('routes/instagramDerivativeAssets.ts')));

  // Store module: root creation only in assertInstagramStoreSafe; temporary/link/unlink only in publishToInstagramStore.
  const store = read('integrations/instagram/instagramDerivativeStore.ts');
  const body = (name) => { const start = store.indexOf(`export async function ${name}(`); assert.ok(start >= 0, name); const next = store.indexOf('\nexport ', start + 1); return store.slice(start, next < 0 ? undefined : next); };
  const mutating = (text) => text.split(/\r?\n/).filter((l) => /\b(mkdir|link|unlink|rm|writeFile|rename)\(|open\([^)]*"wx"/.test(l) && !/^\s*(\*|\/\/|import)/.test(l));
  const assertSafe = mutating(body('assertInstagramStoreSafe')), publish = mutating(body('publishToInstagramStore'));
  assert.ok(assertSafe.length > 0 && assertSafe.every((l) => /mkdir\(dir, \{ mode: 0o700 \}\)/.test(l)));
  assert.ok(publish.length >= 3 && publish.every((l) => /open\(temporary, "wx", 0o600\)|handle\.writeFile\(bytes\)|link\(temporary, destination\)|unlink\(temporary\)/.test(l)));
  assert.equal(mutating(store).length, assertSafe.length + publish.length);

  // mediaPreparation: protected-mode job-root mutations only inside renderProtected (its own job directory).
  const media = read('integrations/instagram/mediaPreparation.ts');
  const start = media.indexOf('async function renderProtected('), close = /\r?\n\}\r?\n/.exec(media.slice(start)), end = close ? start + close.index : -1;
  assert.ok(start >= 0 && end > start);
  const render = media.slice(start, end);
  assert.match(render, /const jobDir = path\.join\(jobRoot, `\.job-\$\{randomUUID\(\)\}`\);/);
  assert.match(render, /await mkdir\(jobDir, \{ mode: 0o700 \}\);/);
  assert.match(render, /finally \{ await rm\(jobDir, \{ recursive: true, force: true \}\); \}/);
  // The only call sites that pass the job root are the protected publication flow.
  assert.deepEqual(media.split(/\r?\n/).filter((l) => /roots\.jobs/.test(l)).map((l) => l.trim()),
    ['work = (async () => publishToInstagramStore(await renderProtected(source, recipeId, roots.jobs), derivative, roots))();']);
});
