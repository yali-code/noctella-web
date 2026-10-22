'use strict';
// Final readiness (Packages A/B/C): AI deterministic finalization end to end in a DISPOSABLE harness:
// proposed ownership schema + real #406 capability (real deterministic recipe, sealing, no-overwrite
// publication) + #411 finalize contract + #408 disk budget + #409 recovery classification.
// Nothing is wired into application routes, workers or schedulers.
// Run: node --import tsx --test scripts/photo-final-readiness/ai-finalize.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-'));
const legacyCanonical = path.join(sandbox, 'legacy-canonical');
fs.mkdirSync(legacyCanonical);
Object.assign(process.env, { NODE_ENV: 'test', PRODUCT_PHOTO_DISK_STAGING_ENABLED: 'true', PRODUCT_PHOTO_DIR: legacyCanonical });
const { UP, LATEST_PG, sqliteEngine, postgresEngine, applyScript } = require('../photo-ownership-schema/contract.cjs');
const { ownershipAuthority } = require('./authority.cjs');
const { ensureSchema } = require('../../apps/api/src/db/migrate.ts');
const { DevelopmentPhotoStorageCapability } = require('../../apps/api/src/services/developmentPhotoStorageCapability.ts');
const { writeDeterministicProductPhoto } = require('../../apps/api/src/services/photoStorage.ts');
const { DevelopmentPhotoDiskBudget, PHOTO_DISK_PROFILES, attemptReservation } = require('../../apps/api/src/services/developmentPhotoDiskBudget.ts');
const { runDevelopmentPhotoRecovery, collectSqlitePhotoReferences, collectPostgresPhotoReferences } = require('../../apps/api/src/services/developmentPhotoRecovery.ts');
const { createRequire } = require('node:module');
const sharp = createRequire(path.resolve(__dirname, '../../apps/api/package.json'))('sharp');

const pgSkip = !process.env.POSTGRES_TEST_DATABASE_URL && 'POSTGRES_TEST_DATABASE_URL not configured';
const evidence = [];
const TTL = 1000;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileProof = (f) => { const s = fs.statSync(f, { bigint: true }); return { ino: s.ino.toString(), size: Number(s.size), sha256: sha(fs.readFileSync(f)) }; };

async function env(driver, { legacyRows = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-'));
  const dirs = { private: path.join(root, 'private'), canonical: path.join(root, 'canonical'), intake: path.join(root, 'intake') };
  fs.mkdirSync(dirs.intake);
  let engine, h;
  if (driver === 'sqlite') { engine = sqliteEngine(path.join(root, 'app.sqlite')); ensureSchema(engine.db); }
  else { h = await require('../../apps/api/tests/postgresTestDb.ts').createPostgresTestDb(LATEST_PG); engine = postgresEngine(h.pool); }
  await engine.q('INSERT INTO products(id,sku,title,slug,type,status) VALUES(?,?,?,?,?,?) RETURNING id', ['prod-1', 'SKU-1', 'Synthetic', 'synthetic-1', 'unique_item', 'draft']);
  let legacyBefore = null;
  if (legacyRows) {
    // Upgrade path: rows (and their files) written by the current application before the additive migration.
    fs.mkdirSync(dirs.canonical, { recursive: true });
    fs.writeFileSync(path.join(dirs.canonical, 'legacy-1.webp'), 'legacy-main'); fs.writeFileSync(path.join(dirs.canonical, 'legacy-1-thumb.webp'), 'legacy-thumb');
    await engine.q("INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id", ['legacy-1', 'prod-1', '/images/product-photos/legacy-1.webp', '/images/product-photos/legacy-1-thumb.webp', 'legacy-1.webp', 'image/webp', 5, 1, 1, 'legacy-1.webp', 'legacy-1-thumb.webp']);
    await engine.q("INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id", ['legacy-evt', 'product_photo.promote_requested', 'ProductPhoto', 'legacy-1', 'product-photo-promote:legacy-1', JSON.stringify({ photoId: 'legacy-1', productId: 'prod-1' }), 'completed', new Date(1).toISOString()]);
    legacyBefore = JSON.stringify([await engine.q('SELECT id, url, storage_key FROM product_photos ORDER BY id'), await engine.q('SELECT id, status FROM outbox_events ORDER BY id')]);
  }
  await applyScript(engine, UP);
  const intents = new Map();
  const authority = ownershipAuthority(engine, intents);
  const cap = new DevelopmentPhotoStorageCapability(authority, dirs.private, dirs.canonical);
  const budget = new DevelopmentPhotoDiskBudget({ budgetRoot: path.join(root, 'budget'), accountedRoots: [dirs.private], budgetBytes: 1024 ** 3, freeSpaceFloorBytes: 0 });
  const references = driver === 'sqlite' ? () => collectSqlitePhotoReferences(engine.db) : () => collectPostgresPhotoReferences(engine.pool);
  const recover = (extra = {}) => runDevelopmentPhotoRecovery({ roots: { canonical: dirs.canonical, private: dirs.private, intake: dirs.intake }, reviewDir: path.join(root, 'review'), references, ...extra });
  const x = { root, dirs, engine, h, intents, authority, c: authority.contract, cap, budget, recover, legacyBefore };
  x.close = async () => { x.engine.close(); await h?.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return x;
}

/** Stage an AI intake source (retained) and register the deterministic operation intent. */
async function stageSource(x, photoId, color) {
  const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).png().toBuffer();
  const key = `${photoId}-source.png`;
  fs.writeFileSync(path.join(x.dirs.intake, key), bytes);
  await x.engine.q('INSERT INTO ai_intake_photos(id,intake_id,storage_key,original_filename,created_by_admin_user_id) VALUES(?,?,?,?,?) RETURNING id', [`iph-${photoId}`, 'intake-1', key, `${photoId}.png`, 'admin-1']);
  const opId = `ai-finalize-${photoId}`;
  x.intents.set(opId, { kind: 'ai_finalize', subjectType: 'ai_intake_photos', subjectId: `iph-${photoId}`, targetPhotoId: `prod-1-${photoId}`, mainKey: `prod-1-${photoId}.webp`, thumbKey: `prod-1-${photoId}-thumb.webp`, inputSha256: sha(bytes) });
  return { bytes, key, opId };
}
const finalizeInput = (sealId, eventId) => ({ sealId, productId: 'prod-1', sizeBytes: 1, width: 48, height: 32, eventId });

/** One complete attempt: reserve -> claim -> prepare (fenced) -> publish (no overwrite) -> finalize (atomic). */
async function finalizeOnce(x, src, { now = 100, owner = 'w1', nonce = 'n1', stopBeforeFinalize = false } = {}) {
  const reservation = x.budget.reserve(PHOTO_DISK_PROFILES.d1CapabilityDeterministic, src.opId.slice(0, 60));
  try {
    const t = await x.cap.begin(src.opId, owner, nonce, now, TTL);
    assert.ok(t, 'claimed');
    const sealId = await x.cap.prepareDeterministic(t, now + 1, src.bytes, 'image/png');
    const published = await x.cap.publish(t, now + 2, sealId);
    if (stopBeforeFinalize) return { t, sealId, published };
    return { t, sealId, published, result: await x.c.finalize(t, now + 3, finalizeInput(sealId, `evt-${src.opId}`)) };
  } finally { reservation.release(); }
}

test.after(() => {
  const dest = process.env.NOCTELLA_FINAL_READINESS_EVIDENCE_DIR;
  if (dest) { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'ai-finalize-evidence.json'), JSON.stringify(evidence, null, 2)); }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

for (const driver of ['sqlite', 'postgres']) {
  const opts = { skip: driver === 'postgres' && pgSkip, timeout: 180_000 };
  const withEnv = (fn, o) => async () => { const x = await env(driver, o); try { await fn(x); } finally { await x.close(); } };

  test(`${driver}: additive upgrade over existing rows, then end-to-end fenced AI finalization with recipe parity`, opts, withEnv(async (x) => {
    assert.equal(JSON.stringify([await x.engine.q('SELECT id, url, storage_key FROM product_photos ORDER BY id'), await x.engine.q('SELECT id, status FROM outbox_events ORDER BY id')]), x.legacyBefore, 'migration leaves existing photo/outbox rows untouched');
    const src = await stageSource(x, 'photo-1', '#ff8800');
    const { result, published } = await finalizeOnce(x, src);
    assert.deepEqual(result, { status: 'committed', photoId: 'prod-1-photo-1', eventId: 'evt-ai-finalize-photo-1' });
    assert.deepEqual(published.status, ['published', 'published']);
    const [row] = await x.engine.q('SELECT url, thumbnail_url, storage_key, thumbnail_storage_key FROM product_photos WHERE id = ?', ['prod-1-photo-1']);
    assert.deepEqual(row, { url: '/images/product-photos/prod-1-photo-1.webp', thumbnail_url: '/images/product-photos/prod-1-photo-1-thumb.webp', storage_key: 'prod-1-photo-1.webp', thumbnail_storage_key: 'prod-1-photo-1-thumb.webp' });
    // Recipe parity: identical bytes to the existing legacy deterministic writer for the same source.
    await writeDeterministicProductPhoto({ buffer: src.bytes, mimetype: 'image/png', size: src.bytes.length, mainStorageKey: 'parity.webp', thumbnailStorageKey: 'parity-thumb.webp' });
    const main = fileProof(path.join(x.dirs.canonical, 'prod-1-photo-1.webp'));
    assert.equal(main.sha256, sha(fs.readFileSync(path.join(legacyCanonical, 'parity.webp'))));
    assert.equal(fileProof(path.join(x.dirs.canonical, 'prod-1-photo-1-thumb.webp')).sha256, sha(fs.readFileSync(path.join(legacyCanonical, 'parity-thumb.webp'))));
    // Idempotent retries: publish again is a no-write, finalize again returns the committed result.
    const op = await x.c.read(src.opId);
    assert.equal(op.state, 'committed');
    assert.deepEqual(await x.c.finalize({ id: op.id, generation: op.generation, owner: op.owner, nonce: op.nonce }, 200, finalizeInput(op.seal_id, 'evt-retry')), { status: 'already-committed', photoId: 'prod-1-photo-1', eventId: 'evt-ai-finalize-photo-1' });
    assert.equal(Number((await x.engine.q("SELECT COUNT(*) AS n FROM product_photos WHERE id = 'prod-1-photo-1'"))[0].n), 1);
    assert.equal(sha(fs.readFileSync(path.join(x.dirs.intake, src.key))), sha(src.bytes), 'AI source retained byte-identical');
    const { report } = await x.recover();
    assert.equal(report.reviewRequired, false);
    assert.deepEqual(report.artifacts.filter((a) => a.root === 'canonical').map((a) => [a.path, a.class]), [['legacy-1-thumb.webp', 'REFERENCED'], ['legacy-1.webp', 'REFERENCED'], ['prod-1-photo-1-thumb.webp', 'REFERENCED'], ['prod-1-photo-1.webp', 'REFERENCED']]);
    assert.equal(report.artifacts.find((a) => a.root === 'intake').class, 'REFERENCED');
    evidence.push({ driver, name: 'e2e', canonical: main, retained: report.retainedBytesByClass });
  }, { legacyRows: true }));

  test(`${driver}: crash after publication before finalize, reclaim, stale token rejection and recovery classification`, opts, withEnv(async (x) => {
    const src = await stageSource(x, 'photo-2', '#2288ff');
    const first = await finalizeOnce(x, src, { stopBeforeFinalize: true });
    const before = fileProof(path.join(x.dirs.canonical, 'prod-1-photo-2.webp'));
    let { report } = await x.recover();
    assert.equal(report.artifacts.find((a) => a.path === 'prod-1-photo-2.webp').reasons[0], `photo_operations.sealed:${src.opId}`, 'pending publication referenced by its operation');
    assert.equal(report.reviewRequired, false);
    // Restart: a new owner may reclaim only after the lease.
    assert.equal(await x.cap.reclaim(src.opId, 1, 'w2', 'n2', 500, TTL), null);
    const t2 = await x.cap.reclaim(src.opId, 1, 'w2', 'n2', 2000, TTL);
    await assert.rejects(async () => x.cap.publish(first.t, 2001, first.sealId), /STALE_FENCE/);
    await assert.rejects(async () => x.c.finalize(first.t, 2001, finalizeInput(first.sealId, 'evt-stale')), /STALE_FENCE/);
    const seal2 = await x.cap.prepareDeterministic(t2, 2002, src.bytes, 'image/png');
    assert.deepEqual((await x.cap.publish(t2, 2003, seal2)).status, ['already-present', 'already-present'], 'identical bytes, no overwrite');
    assert.equal((await x.c.finalize(t2, 2004, finalizeInput(seal2, 'evt-2'))).status, 'committed');
    assert.deepEqual(fileProof(path.join(x.dirs.canonical, 'prod-1-photo-2.webp')), before, 'canonical inode and bytes preserved');
    ({ report } = await x.recover());
    const g1 = report.artifacts.filter((a) => a.root === 'private' && a.path.startsWith(`${src.opId}/g1/`));
    assert.ok(g1.length > 0);
    assert.ok(g1.every((a) => (a.path.includes('/sealed/') ? a.class === 'REFERENCED_VIA_CANONICAL_LINK' : a.class === 'UNREFERENCED_CANDIDATE')), JSON.stringify(g1.map((a) => [a.path, a.class])));
    assert.equal(report.cleanup, 'BLOCKED_NOT_AUTHORIZED');
    assert.ok(report.retainedBytesByClass.UNREFERENCED_CANDIDATE > 0, 'superseded private bytes reported, never freed');
    evidence.push({ driver, name: 'crash-reclaim', retained: report.retainedBytesByClass });
  }));

  test(`${driver}: legacy writer at the same canonical key is preserved; the operation moves to review and recovery requires review`, opts, withEnv(async (x) => {
    const src = await stageSource(x, 'photo-3', '#00aa44');
    const t = await x.cap.begin(src.opId, 'w1', 'n1', 100, TTL);
    const sealId = await x.cap.prepareDeterministic(t, 101, src.bytes, 'image/png');
    fs.writeFileSync(path.join(x.dirs.canonical, 'prod-1-photo-3.webp'), 'old-instance-bytes'); // unfenced legacy write
    const foreign = fileProof(path.join(x.dirs.canonical, 'prod-1-photo-3.webp'));
    await assert.rejects(async () => x.cap.publish(t, 102, sealId), /PHOTO_PUBLICATION_CONFLICT_RETAINED/);
    // Fail closed: the adapter records the conflict for operator review; finalize never runs.
    await x.engine.q("UPDATE photo_operations SET state = 'review', review_reason = 'PUBLICATION_CONFLICT' WHERE id = ? RETURNING id", [src.opId]);
    assert.deepEqual(fileProof(path.join(x.dirs.canonical, 'prod-1-photo-3.webp')), foreign);
    assert.equal(Number((await x.engine.q('SELECT COUNT(*) AS n FROM product_photos'))[0].n), 0);
    const { report } = await x.recover();
    assert.deepEqual(report.reviewOperations, [src.opId]);
    assert.equal(report.reviewRequired, true);
    assert.deepEqual(await x.c.finalize(t, 103, finalizeInput(sealId, 'evt-3')), { status: 'review', reason: 'PUBLICATION_CONFLICT' });
  }));

  test(`${driver}: retained generations accumulate and conservative admission refuses the next attempt whole`, opts, withEnv(async (x) => {
    const R = attemptReservation(PHOTO_DISK_PROFILES.d1CapabilityDeterministic, 4096).bytes;
    // Exactly one reservation plus one block of slack.
    x.budget = new DevelopmentPhotoDiskBudget({ budgetBytes: R + 4096, budgetRoot: path.join(x.root, 'budget-tight'), accountedRoots: [x.dirs.private], freeSpaceFloorBytes: 0 });
    const a = await stageSource(x, 'photo-4', '#aa00aa');
    assert.equal((await finalizeOnce(x, a)).result.status, 'committed');
    const after = x.budget.snapshot();
    assert.ok(after.retainedBytes > 0, 'successful attempt keeps private input/raw/sealed bytes');
    const b = await stageSource(x, 'photo-5', '#123456');
    assert.throws(() => x.budget.reserve(PHOTO_DISK_PROFILES.d1CapabilityDeterministic, 'photo-5'), /PHOTO_DISK_BUDGET_EXHAUSTED/);
    assert.equal(await x.c.read(b.opId), null, 'refused before any claim or write');
    evidence.push({ driver, name: 'budget-accumulation', reservation: R, retainedAfterOne: after.retainedBytes });
  }));
}
