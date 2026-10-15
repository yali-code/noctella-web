'use strict';
// P2-2B3D6 (#396/#403/#407): deterministic shutdown-gate tests for legacy writers 1, 6, 8, 9, 10.
// Disposable roots only; real legacy functions are driven through test adapters; nothing is wired
// into the application. Run: node --import tsx --test scripts/photo-legacy-gate/gate.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-'));
const canonical = path.join(sandbox, 'canonical');
fs.mkdirSync(canonical);
// photoStorage reads PRODUCT_PHOTO_DIR at module load: point the real legacy storage at the sandbox.
Object.assign(process.env, { NODE_ENV: 'test', PRODUCT_PHOTO_DISK_STAGING_ENABLED: 'true', PRODUCT_PHOTO_DIR: canonical });
const { DevelopmentLegacyWriterGate } = require('../../apps/api/src/services/developmentLegacyWriterGate.ts');
const { ProductPhotoDeleteHandler, ProductPhotoCleanupTempHandler } = require('../../apps/api/src/services/productPhotoStorageWorkflow.ts');
const { deleteManagedFile } = require('../../apps/api/src/services/managedFileDeletion.ts');
const { LocalPhotoStorage, productPhotoStaticRoot } = require('../../apps/api/src/services/photoStorage.ts');
const { ensureSchema } = require('../../apps/api/src/db/migrate.ts');
const { runDevelopmentPhotoRecovery, collectSqlitePhotoReferences, collectPostgresPhotoReferences } = require('../../apps/api/src/services/developmentPhotoRecovery.ts');
const { createRequire } = require('node:module');
const api = createRequire(path.resolve(__dirname, '../../apps/api/package.json'));

assert.equal(path.resolve(productPhotoStaticRoot), path.resolve(canonical), 'legacy storage must target the sandbox');
const evidence = [];
const pgSkip = !process.env.POSTGRES_TEST_DATABASE_URL && 'POSTGRES_TEST_DATABASE_URL not configured';
const roots = { tempRoot: canonical, permanentRoot: canonical, publicBase: '/images/product-photos' }; // production: temp root == canonical root
const freshGate = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-gate-')); const g = new DevelopmentLegacyWriterGate(dir); g.initialize(); return { g, dir }; };
const proof = (dir) => fs.readdirSync(dir).filter((n) => !n.startsWith('gate-')).sort().map((n) => { const f = path.join(dir, n); const s = fs.statSync(f, { bigint: true }); return `${n} ${s.ino} ${s.size} ${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`; });
const put = (name, bytes) => fs.writeFileSync(path.join(canonical, name), bytes);
const event = (type, key) => ({ id: `evt-${key}`, eventType: type, aggregateType: 'ProductPhoto', aggregateId: key, payload: { photoId: key, storageKey: `${key}.webp`, thumbnailStorageKey: `${key}-thumb.webp` } });

/** Test adapter = the wrapper a production change would add around each legacy mutation entry point. */
async function gated(gate, writer, mutation, eventType) {
  if (eventType && !gate.dispatchAllowed(eventType)) return 'parked';
  const lease = gate.enter(writer);
  try { lease.checkpoint(); return await mutation(lease); } finally { lease.exit(); }
}
const drainReady = (gate, rows) => gate.drainStatus(rows);
const shutdown = (gate, rows) => { const d = gate.transition(gate.current().epoch, 'DRAINING', 'shutdown'); const report = gate.drainStatus(rows); return { d, report, closed: report.ready ? gate.transition(report.epoch, 'CLOSED', 'drained', report) : null }; };

test.after(() => {
  const dest = process.env.NOCTELLA_LEGACY_GATE_EVIDENCE_DIR;
  if (dest) { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'legacy-gate-evidence.json'), JSON.stringify(evidence, null, 2)); }
  for (const dir of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('noctella-photo-fence-gate-'))) fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('feature OFF: the gate refuses construction without the development flag or a disposable root', () => {
  process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = 'false';
  try { assert.throws(() => new DevelopmentLegacyWriterGate(path.join(os.tmpdir(), 'noctella-photo-fence-x')), /PHOTO_DEVELOPMENT_LEGACY_GATE_DISABLED/); }
  finally { process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = 'true'; }
  assert.throws(() => new DevelopmentLegacyWriterGate(path.join(os.homedir(), 'gate')), /PHOTO_DISPOSABLE_LEGACY_GATE_REQUIRED/);
});

test('baseline (ungated): W8/W9 handlers now refuse without authoritative proof; the raw AI-cleanup delete primitive still deletes', async () => {
  for (const k of ['base-del', 'base-tmp']) { put(`${k}.webp`, k); put(`${k}-thumb.webp`, k); }
  put('base-ai.webp', 'ai');
  // Safety remediation: no reference checker -> no deletion; temp root == canonical root -> no deletion.
  await assert.rejects(() => new ProductPhotoDeleteHandler(roots).handle(event('product_photo.delete_requested', 'base-del')), (e) => e.code === 'PHOTO_DELETE_REFERENCE_UNKNOWN' && e.permanent === true);
  await assert.rejects(() => new ProductPhotoCleanupTempHandler(roots).handle(event('product_photo.cleanup_temp_requested', 'base-tmp')), (e) => e.code === 'PHOTO_TEMP_ROOT_IS_CANONICAL');
  assert.deepEqual(['base-del.webp', 'base-del-thumb.webp', 'base-tmp.webp', 'base-tmp-thumb.webp'].filter((n) => fs.existsSync(path.join(canonical, n))), ['base-del.webp', 'base-del-thumb.webp', 'base-tmp.webp', 'base-tmp-thumb.webp'], 'W8/W9 preserve canonical bytes');
  // Still-unsafe baseline (synthetic file): the raw managed-file delete used by W6 deletes when called ungated.
  assert.equal(await deleteManagedFile(canonical, 'base-ai.webp'), 'regular_file');
  assert.equal(fs.existsSync(path.join(canonical, 'base-ai.webp')), false, 'W6 primitive baseline reproduced');
  evidence.push({ name: 'ungated-baseline', preserved: ['base-del', 'base-tmp'], deleted: ['base-ai'] });
});

test('in-flight legacy upload during shutdown: checkpoint denies new mutation, closure waits for the lease', async () => {
  const { g } = freshGate();
  const lease = g.enter('W1_LEGACY_UPLOAD');
  lease.checkpoint();
  const storage = new LocalPhotoStorage();
  const png = await api('sharp')({ create: { width: 16, height: 12, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const saved = await storage.saveProductPhoto({ buffer: png, mimetype: 'image/png', size: png.length }); // passed checkpoint before DRAINING
  const draining = g.transition(1, 'DRAINING', 'shutdown');
  assert.throws(() => lease.checkpoint(), /LEGACY_WRITER_GATE_CLOSED/, 'a second mutation by the same request is denied');
  assert.throws(() => g.enter('W1_LEGACY_UPLOAD'), /LEGACY_WRITER_GATE_CLOSED/);
  const blocked = g.drainStatus([]);
  assert.equal(blocked.ready, false);
  assert.throws(() => g.transition(draining.epoch, 'CLOSED', 'early', blocked), /GATE_DRAIN_UNPROVEN/);
  lease.exit();
  const ready = g.drainStatus([]);
  assert.equal(ready.ready, true);
  assert.equal(g.transition(ready.epoch, 'CLOSED', 'drained', ready).state, 'CLOSED');
  assert.ok(fs.existsSync(path.join(canonical, saved.filename)), 'the admitted upload completed and is retained');
});

test('outbox worker interrupted before/after acknowledgement: parked when not OPEN, closure needs terminal events', async () => {
  const { g } = freshGate();
  put('ob.webp', 'ob'); put('ob-thumb.webp', 'ob');
  const before = proof(canonical);
  g.transition(1, 'DRAINING', 'shutdown');
  const handler = new ProductPhotoDeleteHandler(roots);
  assert.equal(await gated(g, 'W8_OUTBOX_DELETE', () => handler.handle(event('product_photo.delete_requested', 'ob')), 'product_photo.delete_requested'), 'parked');
  assert.deepEqual(proof(canonical), before, 'parked delete never touched bytes');
  const claimedNotAcked = [{ id: 'e1', event_type: 'product_photo.delete_requested', status: 'processing', locked_by: 'worker-1' }];
  assert.equal(g.drainStatus(claimedNotAcked).ready, false, 'interrupted before ack keeps the gate DRAINING');
  const acked = [{ id: 'e1', event_type: 'product_photo.delete_requested', status: 'completed', locked_by: null }, { id: 'e2', event_type: 'product_photo.promote_requested', status: 'pending', locked_by: null }];
  const ready = g.drainStatus(acked);
  assert.equal(ready.ready, true, 'acknowledged dangerous events are terminal; promotion events do not block');
  assert.equal(g.transition(ready.epoch, 'CLOSED', 'drained', ready).state, 'CLOSED');
  assert.equal(g.dispatchAllowed('product_photo.promote_requested'), true, 'non-destructive outbox work continues');
});

test('stale legacy writer after shutdown and repeated shutdown/startup cannot reuse an old epoch (ABA)', async () => {
  const { g, dir } = freshGate();
  const old = g.enter('W10_UPLOAD_ROLLBACK');
  g.transition(1, 'DRAINING', 'first shutdown');
  assert.throws(() => old.checkpoint(), /LEGACY_WRITER_GATE_CLOSED/);
  old.exit();
  const r = g.drainStatus([]);
  g.transition(r.epoch, 'CLOSED', 'drained', r);
  const reopened = g.transition(3, 'OPEN', 'rollback/startup');
  assert.equal(reopened.epoch, 4);
  assert.throws(() => old.checkpoint(), /LEGACY_WRITER_LEASE_EXITED/);
  const fresh = g.enter('W10_UPLOAD_ROLLBACK');
  fresh.checkpoint();
  g.transition(4, 'DRAINING', 'second shutdown');
  assert.throws(() => fresh.checkpoint(), /LEGACY_WRITER_GATE_CLOSED/, 'epoch 4 lease dies at epoch 5');
  assert.throws(() => g.transition(4, 'CLOSED', 'stale cas'), /GATE_EPOCH_CHANGED/);
  fresh.exit();
  // Gate history is append-only: every epoch file still exists, none was overwritten.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'epochs')).sort(), ['1.json', '2.json', '3.json', '4.json', '5.json']);
  assert.deepEqual(['OPEN', 'DRAINING', 'CLOSED', 'OPEN', 'DRAINING'], [1, 2, 3, 4, 5].map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'epochs', `${n}.json`), 'utf8')).state));
});

test('lost COMMIT acknowledgement: gated rollback deletion is refused once draining, bytes retained', async () => {
  const { g } = freshGate();
  const storage = new LocalPhotoStorage();
  const png = await api('sharp')({ create: { width: 16, height: 12, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const stored = await storage.saveProductPhoto({ buffer: png, mimetype: 'image/png', size: png.length });
  const before = proof(canonical);
  g.transition(1, 'DRAINING', 'shutdown');
  // Transaction outcome unknown: the legacy path would call deleteProductPhoto here.
  await assert.rejects(() => gated(g, 'W10_UPLOAD_ROLLBACK', () => storage.deleteProductPhoto(stored)), /LEGACY_WRITER_GATE_CLOSED/);
  assert.deepEqual(proof(canonical), before);
});

test('concurrent delete versus a new sealed generation at the same key: the delete stays parked', async () => {
  const { g } = freshGate();
  const pendingDelete = [{ id: 'd1', event_type: 'product_photo.delete_requested', status: 'pending', locked_by: null }];
  g.transition(1, 'DRAINING', 'shutdown');
  put('k.webp', 'new-sealed-generation'); put('k-thumb.webp', 'new-thumb');
  const before = proof(canonical);
  assert.equal(await gated(g, 'W8_OUTBOX_DELETE', () => new ProductPhotoDeleteHandler(roots).handle(event('product_photo.delete_requested', 'k')), 'product_photo.delete_requested'), 'parked');
  assert.deepEqual(proof(canonical), before, 'new generation bytes preserved');
  const report = g.drainStatus(pendingDelete);
  assert.equal(report.ready, false, 'a pending delete needs operator disposition; it is never auto-acknowledged');
  assert.deepEqual(report.dangerousEvents, ['d1:product_photo.delete_requested:pending']);
});

test('unknown or unavailable state fails closed', () => {
  const { g, dir } = freshGate();
  g.transition(1, 'DRAINING', 'shutdown');
  const unknown = g.drainStatus(null);
  assert.equal(unknown.ready, false);
  assert.throws(() => g.transition(unknown.epoch, 'CLOSED', 'no db', unknown), /GATE_DRAIN_UNPROVEN/);
  fs.writeFileSync(path.join(dir, 'epochs', '3.json'), '{partial'); // torn write of a newer epoch
  assert.throws(() => g.current(), /GATE_UNAVAILABLE/);
  assert.throws(() => g.enter('W6_AI_CLEANUP'), /GATE_UNAVAILABLE/);
  assert.equal(g.dispatchAllowed('product_photo.delete_requested'), false);
  assert.equal(g.dispatchAllowed('product_photo.promote_requested'), true);
});

test('SIGKILL inside a legacy lease, then restart: the marker is retained and closure stays refused', { timeout: 120_000 }, async () => {
  const { g, dir } = freshGate();
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'worker.cjs'), dir, 'W6_AI_CLEANUP'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../..') });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`worker timeout ${err}`)), 90_000); child.stdout.on('data', (d) => { if (String(d).includes('inside-lease')) { clearTimeout(t); resolve(); } }); });
  child.kill('SIGKILL');
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const restarted = new DevelopmentLegacyWriterGate(dir);
  restarted.transition(restarted.current().epoch, 'DRAINING', 'shutdown after crash');
  const report = restarted.drainStatus([]);
  assert.equal(report.ready, false);
  assert.equal(report.inflight.length, 1);
  assert.match(report.inflight[0], /^W6_AI_CLEANUP-/);
  assert.throws(() => restarted.transition(report.epoch, 'CLOSED', 'x', { ...report, ready: true }), /GATE_DRAIN_UNPROVEN/, 'a forged ready report cannot bypass retained markers');
  evidence.push({ name: 'sigkill-lease', exit, inflight: report.inflight });
});

test('rollback to OPEN deletes nothing; all canonical bytes and inodes unchanged across the whole shutdown cycle', async () => {
  const { g } = freshGate();
  put('rb.webp', 'rb'); put('rb-thumb.webp', 'rb');
  const before = proof(canonical);
  const { report, closed } = shutdown(g, []);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(await gated(g, 'W9_OUTBOX_TEMP_CLEANUP', () => new ProductPhotoCleanupTempHandler(roots).handle(event('product_photo.cleanup_temp_requested', 'rb')), 'product_photo.cleanup_temp_requested'), 'parked');
  await assert.rejects(() => gated(g, 'W6_AI_CLEANUP', () => deleteManagedFile(canonical, 'rb.webp')), /LEGACY_WRITER_GATE_CLOSED/);
  const reopened = g.transition(closed.epoch, 'OPEN', 'rollback');
  assert.equal(reopened.state, 'OPEN');
  assert.deepEqual(proof(canonical), before);
  evidence.push({ name: 'rollback', report, reopened, proof: before });
});

for (const driver of ['sqlite', 'postgres']) {
  test(`${driver}: drain readiness reads real outbox rows; outbox-only history keeps canonical bytes referenced while gated`, { skip: driver === 'postgres' && pgSkip, timeout: 120_000 }, async () => {
    let q, collect, close;
    if (driver === 'sqlite') {
      const Database = api('better-sqlite3'); const db = new Database(':memory:'); ensureSchema(db);
      q = async (sql, args = []) => { const st = db.prepare(sql); return st.reader ? st.all(...args) : (st.run(...args), []); };
      collect = () => collectSqlitePhotoReferences(db); close = async () => db.close();
    } else {
      const h = await require('../../apps/api/tests/postgresTestDb.ts').createPostgresTestDb('0038_background_job_claim_fencing.sql');
      q = async (sql, args = []) => { let i = 0; return (await h.pool.query(sql.replace(/\?/g, () => `$${++i}`), args)).rows; };
      collect = () => collectPostgresPhotoReferences(h.pool); close = () => h.close();
    }
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-gate-'));
      const canon = path.join(root, 'canonical'); fs.mkdirSync(canon);
      fs.writeFileSync(path.join(canon, 'hist.webp'), 'hist'); fs.writeFileSync(path.join(canon, 'hist-thumb.webp'), 'hist');
      await q('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at) VALUES(?,?,?,?,?,?,?,?)',
        ['h1', 'product_photo.delete_requested', 'ProductPhoto', 'gone', 'product-photo-delete:gone', JSON.stringify({ photoId: 'gone', storageKey: 'hist.webp', thumbnailStorageKey: 'hist-thumb.webp' }), 'completed', new Date().toISOString()]);
      await q('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at,locked_by) VALUES(?,?,?,?,?,?,?,?,?)',
        ['c1', 'product_photo.cleanup_temp_requested', 'ProductPhoto', 'x', 'product-photo-cleanup:x', JSON.stringify({ storageKey: 'x.webp' }), 'processing', new Date().toISOString(), 'worker-2']);
      const rows = await q("SELECT id, event_type, status, locked_by FROM outbox_events WHERE event_type IN ('product_photo.delete_requested','product_photo.cleanup_temp_requested') ORDER BY id");
      const g = new DevelopmentLegacyWriterGate(path.join(root, 'gate')); g.initialize();
      g.transition(1, 'DRAINING', 'shutdown');
      const report = g.drainStatus(rows);
      assert.deepEqual(report.dangerousEvents, ['c1:product_photo.cleanup_temp_requested:processing']);
      assert.equal(report.ready, false);
      const { report: classified } = await runDevelopmentPhotoRecovery({ roots: { canonical: canon }, reviewDir: path.join(root, 'review'), references: collect });
      assert.deepEqual(classified.artifacts.map((a) => [a.path, a.class]).sort(), [['hist-thumb.webp', 'REFERENCED'], ['hist.webp', 'REFERENCED']]);
      evidence.push({ driver, name: 'outbox-drain-parity', report, classified: classified.artifacts.map((a) => [a.path, a.class, a.reasons[0]]) });
    } finally { await close(); }
  });
}
