'use strict';
// P2-2B3D3 (#396): deterministic, disposable recovery-classification acceptance tests.
// Run: node --import tsx --test scripts/photo-recovery-reconciliation/recovery.test.cjs
// PostgreSQL cases run when POSTGRES_TEST_DATABASE_URL points at a disposable local database (CI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { fixture } = require('../photo-storage-capability/fixture.cjs');
const { ensureSchema } = require('../../apps/api/src/db/migrate.ts');
const { runDevelopmentPhotoRecovery, collectSqlitePhotoReferences, collectPostgresPhotoReferences } = require('../../apps/api/src/services/developmentPhotoRecovery.ts');
const { DevelopmentPhotoDiskBudget, PHOTO_DISK_PROFILES } = require('../../apps/api/src/services/developmentPhotoDiskBudget.ts');

const drivers = ['sqlite', 'postgres'];
const pgSkip = !process.env.POSTGRES_TEST_DATABASE_URL && 'POSTGRES_TEST_DATABASE_URL not configured';
const evidenceDir = process.env.NOCTELLA_RECOVERY_EVIDENCE_DIR;
const evidence = [];

async function env(driver) {
  const f = await fixture(driver);
  const q = (sql, args = []) => f.p.q(sql, args);
  try {
    if (driver === 'sqlite') ensureSchema(f.p.connection);
    await q("INSERT INTO products(id,sku,title,slug,type,status) VALUES(?,?,?,?,?,?) RETURNING id", ['prod-1', 'SKU-1', 'Synthetic', 'synthetic-1', 'unique_item', 'draft']);
  } catch (error) {
    await f.p.close(); if (f.h) await f.h.close(); fs.rmSync(f.root, { recursive: true, force: true });
    throw error;
  }
  const roots = { canonical: path.join(f.root, 'canonical'), private: path.join(f.root, 'private'), intake: path.join(f.root, 'intake'), media: path.join(f.root, 'media') };
  for (const dir of [roots.intake, roots.media]) fs.mkdirSync(dir, { recursive: true });
  const references = () => (driver === 'sqlite' ? collectSqlitePhotoReferences(f.p.connection) : collectPostgresPhotoReferences(f.h.pool));
  const closed = [];
  const recover = (extra = {}) => runDevelopmentPhotoRecovery({ roots, reviewDir: path.join(f.root, 'review'), references, closeAdmission: (reason) => closed.push(reason), ...extra });
  const photo = (id, published) => q('INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
    [id, 'prod-1', published.url, published.thumbnailUrl, published.filename, 'image/webp', 1, 32, 24, published.filename, path.basename(published.thumbnailUrl)]);
  const outbox = (id, type, status, payload) => q('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id',
    [id, type, 'ProductPhoto', payload.photoId ?? id, `${type}:${id}`, JSON.stringify(payload), status, new Date().toISOString()]);
  const publishOnce = async (op = 'op') => { const a = await f.cap.begin(op, 'a', `claim-${op}`, 100, 100); const seal = await f.cap.prepareProduct(a, 101, f.bytes); return { token: a, published: await f.cap.publish(a, 102, seal) }; };
  return { f, q, roots, recover, closed, photo, outbox, publishOnce, defaultReferences: references };
}

/** Hash + inode inventory of every artifact outside the recovery's own review directory. */
function tree(root) {
  const rows = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'review' && e.name !== 'budget') walk(file); continue; } if (/probe\.sqlite/.test(e.name)) continue; const s = fs.lstatSync(file, { bigint: true }); rows.push([path.relative(root, file), s.ino.toString(), s.size.toString(), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')].join(' ')); } };
  walk(root);
  return rows.sort();
}
const byClass = (report, cls) => report.artifacts.filter((a) => a.class === cls).map((a) => `${a.root}:${a.path}`);
const classOf = (report, rel) => report.artifacts.find((a) => `${a.root}:${a.path}` === rel)?.class;

async function scenario(driver, name, body) {
  const ctx = await env(driver);
  try {
    const counts = async () => JSON.stringify(await ctx.q('SELECT (SELECT COUNT(*) FROM product_photos) AS photos, (SELECT COUNT(*) FROM outbox_events) AS events'));
    await body(ctx, async (extra) => {
      // Baseline at the end of the snapshot callback: simulated writers may act until then;
      // afterwards only the recovery runs (inventory B + its own review record).
      let before = tree(ctx.f.root), rowsBefore = await counts();
      const references = (extra && extra.references) || ctx.defaultReferences;
      const result = await ctx.recover({ ...extra, references: async () => { const snapshot = await references(); before = tree(ctx.f.root); rowsBefore = await counts(); return snapshot; } });
      assert.deepEqual(tree(ctx.f.root), before, 'recovery must not mutate any artifact');
      assert.equal(await counts(), rowsBefore, 'recovery must not mutate the database');
      assert.equal(result.report.cleanup, 'BLOCKED_NOT_AUTHORIZED');
      assert.ok(fs.existsSync(result.recordPath), 'durable review record written');
      evidence.push({ driver, name, recordPath: path.basename(result.recordPath), report: result.report });
      return result.report;
    });
  } finally {
    await ctx.f.p.close();
    if (ctx.f.h) await ctx.f.h.close();
    fs.rmSync(ctx.f.root, { recursive: true, force: true });
  }
}

for (const driver of drivers) {
  const opts = { skip: driver === 'postgres' && pgSkip, timeout: 120_000 };

  test(`${driver}: referenced canonical photo and its sealed links are preserved, no review`, opts, () => scenario(driver, 'referenced', async (c, recover) => {
    const { published } = await c.publishOnce();
    await c.photo('photo-1', published);
    const report = await recover();
    assert.equal(classOf(report, 'canonical:op.webp'), 'REFERENCED');
    assert.equal(classOf(report, `canonical:${path.basename(published.thumbnailUrl)}`), 'REFERENCED');
    assert.equal(byClass(report, 'REFERENCED_VIA_CANONICAL_LINK').length, 2);
    assert.ok(byClass(report, 'CURRENT_GENERATION_RETAINED').length >= 3);
    assert.deepEqual(byClass(report, 'UNREFERENCED_CANDIDATE'), []);
    assert.equal(report.reviewRequired, false);
    assert.deepEqual(c.closed, []);
  }));

  test(`${driver}: historical outbox-only reference keeps the canonical file referenced`, opts, () => scenario(driver, 'outbox-historical', async (c, recover) => {
    const { published } = await c.publishOnce();
    await c.outbox('evt-1', 'product_photo.delete_requested', 'completed', { photoId: 'deleted-photo', url: published.url, thumbnailUrl: published.thumbnailUrl, storageKey: published.filename, thumbnailStorageKey: path.basename(published.thumbnailUrl) });
    const report = await recover();
    assert.equal(classOf(report, 'canonical:op.webp'), 'REFERENCED');
    assert.match(report.artifacts.find((a) => a.path === 'op.webp').reasons.join(','), /outbox_events\.product_photo\.delete_requested\.completed/);
    assert.equal(report.reviewRequired, false);
  }));

  test(`${driver}: lost COMMIT acknowledgement is ambiguous until the authoritative row is visible`, opts, () => scenario(driver, 'lost-commit-ack', async (c, recover) => {
    const { published } = await c.publishOnce();
    // Publication succeeded; the DB outcome is unknown (row absent in this snapshot).
    let report = await recover();
    assert.equal(classOf(report, 'canonical:op.webp'), 'AMBIGUOUS_UNFENCED_ROOT');
    assert.equal(report.reviewRequired, true);
    assert.equal(c.closed.length, 1, 'admission closes fail-closed');
    // The commit had in fact succeeded: once visible, the same bytes are referenced.
    await c.photo('photo-1', published);
    report = await recover();
    assert.equal(classOf(report, 'canonical:op.webp'), 'REFERENCED');
    assert.equal(report.reviewRequired, false);
  }));

  test(`${driver}: stale generation, seals, ABA future generation and unknown operation`, opts, () => scenario(driver, 'stale-generation-aba', async (c, recover) => {
    const a = await c.f.cap.begin('op', 'a', 'claim-a', 100, 100);
    await c.f.cap.prepareProduct(a, 101, c.f.bytes);
    const b = await c.f.cap.reclaim('op', 1, 'b', 'claim-b', 200, 100);
    const published = await c.f.cap.publish(b, 202, await c.f.cap.prepareProduct(b, 201, c.f.bytes));
    await c.photo('photo-1', published);
    const future = path.join(c.roots.private, 'op', 'g9', 'x', 'raw'); fs.mkdirSync(future, { recursive: true }); fs.writeFileSync(path.join(future, 'late.webp'), 'aba');
    const ghost = path.join(c.roots.private, 'ghost', 'g1', 'x', 'raw'); fs.mkdirSync(ghost, { recursive: true }); fs.writeFileSync(path.join(ghost, 'orphan.webp'), 'ghost');
    const report = await recover();
    const g1 = report.artifacts.filter((x) => x.path.startsWith('op/g1/'));
    assert.ok(g1.filter((x) => !x.path.includes('/sealed/')).every((x) => x.class === 'UNREFERENCED_CANDIDATE'), JSON.stringify(g1));
    assert.ok(g1.filter((x) => x.path.includes('/sealed/')).every((x) => x.class === 'SEALED_RECORD_RETAINED'));
    assert.equal(classOf(report, 'private:op/g9/x/raw/late.webp'), 'AMBIGUOUS_FUTURE_GENERATION');
    assert.equal(classOf(report, 'private:ghost/g1/x/raw/orphan.webp'), 'AMBIGUOUS_UNKNOWN_OPERATION');
    assert.equal(report.reviewRequired, true);
  }));

  test(`${driver}: zero-byte and partial artifacts are never treated as safe outside a superseded generation`, opts, () => scenario(driver, 'zero-byte-partial', async (c, recover) => {
    const a = await c.f.cap.begin('op', 'a', 'claim-a', 100, 100);
    await c.f.cap.prepareProduct(a, 101, c.f.bytes);
    await c.f.cap.reclaim('op', 1, 'b', 'claim-b', 200, 100);
    const attempt = fs.readdirSync(path.join(c.roots.private, 'op', 'g1'))[0];
    fs.writeFileSync(path.join(c.roots.private, 'op', 'g1', attempt, 'raw', 'killed-encode.webp'), '');
    fs.writeFileSync(path.join(c.roots.canonical, 'reserved-placeholder.webp'), '');
    const report = await recover();
    assert.equal(classOf(report, 'canonical:reserved-placeholder.webp'), 'AMBIGUOUS_ZERO_BYTE');
    const partial = report.artifacts.find((x) => x.path.endsWith('killed-encode.webp'));
    assert.equal(partial.class, 'UNREFERENCED_CANDIDATE');
    assert.match(partial.reasons.join(), /zero-byte partial output/);
    assert.equal(report.reviewRequired, true);
  }));

  test(`${driver}: unavailable or incomplete database state classifies everything ambiguous and closes admission`, opts, () => scenario(driver, 'db-unavailable', async (c, recover) => {
    await c.publishOnce();
    const report = await recover({ references: async () => { throw new Error('PHOTO_REFERENCE_SOURCE_MISSING:product_photos'); } });
    assert.ok(report.artifacts.every((x) => x.class === 'AMBIGUOUS_DB_UNAVAILABLE'));
    assert.equal(report.snapshotError, 'PHOTO_REFERENCE_SOURCE_MISSING:product_photos');
    assert.equal(report.reviewRequired, true);
    assert.equal(c.closed.length, 1);
  }));

  test(`${driver}: legacy writers and deleters (mixed version) force review`, opts, () => scenario(driver, 'mixed-version-legacy', async (c, recover) => {
    const { published } = await c.publishOnce();
    await c.photo('photo-1', published);
    fs.writeFileSync(path.join(c.roots.canonical, '1700000000000-legacy.webp'), 'legacy-unfenced-upload');
    fs.writeFileSync(path.join(c.roots.canonical, '.instagram-tmp.tmp'), 'instagram-temp');
    fs.unlinkSync(path.join(c.roots.canonical, path.basename(published.thumbnailUrl))); // legacy key-based deleter
    const report = await recover();
    assert.equal(classOf(report, 'canonical:1700000000000-legacy.webp'), 'AMBIGUOUS_UNFENCED_ROOT');
    assert.equal(classOf(report, 'canonical:.instagram-tmp.tmp'), 'AMBIGUOUS_UNFENCED_ROOT');
    assert.deepEqual(report.missingReferenced.map((m) => m.name), [path.basename(published.thumbnailUrl)]);
    assert.equal(report.reviewRequired, true);
  }));

  test(`${driver}: concurrent recovery and an active writer never yield a changing file as a candidate`, opts, () => scenario(driver, 'concurrent-active-writer', async (c, recover) => {
    const a = await c.f.cap.begin('op', 'a', 'claim-a', 100, 100);
    await c.f.cap.prepareProduct(a, 101, c.f.bytes);
    const b = await c.f.cap.reclaim('op', 1, 'b', 'claim-b', 200, 100);
    const attempt = fs.readdirSync(path.join(c.roots.private, 'op', 'g1'))[0];
    const stale = path.join(c.roots.private, 'op', 'g1', attempt, 'work', 'input');
    const report = await recover({ references: async () => {
      // Between inventory A and B: a late native writer touches the stale generation, the new owner produces.
      fs.appendFileSync(stale, 'late');
      await c.f.cap.prepareProduct(b, 201, c.f.bytes);
      return c.f.p.connection.prepare ? collectSqlitePhotoReferences(c.f.p.connection) : collectPostgresPhotoReferences(c.f.h.pool);
    } });
    assert.equal(classOf(report, `private:op/g1/${attempt}/work/input`), 'AMBIGUOUS_CHANGING');
    const g2 = report.artifacts.filter((x) => x.path.startsWith('op/g2/'));
    assert.ok(g2.length > 0 && g2.every((x) => ['CURRENT_GENERATION_RETAINED', 'SEALED_RECORD_RETAINED'].includes(x.class)), JSON.stringify(g2));
    // Two recoveries at once: independent durable records, identical classification, no mutation.
    const [x, y] = await Promise.all([recover(), recover()]);
    assert.notEqual(x.id, y.id);
    assert.deepEqual(x.artifacts.map((r) => [r.path, r.class]), y.artifacts.map((r) => [r.path, r.class]));
  }));

  test(`${driver}: retained-generation accounting is unchanged by recovery and review closes the disk budget`, opts, () => scenario(driver, 'budget-accounting', async (c, recover) => {
    const a = await c.f.cap.begin('op', 'a', 'claim-a', 100, 100);
    await c.f.cap.prepareProduct(a, 101, c.f.bytes);
    await c.f.cap.reclaim('op', 1, 'b', 'claim-b', 200, 100);
    const budget = new DevelopmentPhotoDiskBudget({ budgetRoot: path.join(c.f.root, 'budget'), accountedRoots: [c.roots.private], budgetBytes: 1024 * 1024 * 1024, freeSpaceFloorBytes: 0 });
    const before = budget.snapshot();
    fs.writeFileSync(path.join(c.roots.canonical, 'unreferenced.webp'), 'x');
    const report = await recover({ closeAdmission: (reason) => budget.close(reason) });
    const after = budget.snapshot();
    assert.equal(after.retainedBytes, before.retainedBytes, 'classification reclaims nothing');
    assert.ok((report.retainedBytesByClass.UNREFERENCED_CANDIDATE ?? 0) > 0, 'candidate bytes are reported, not freed');
    assert.equal(after.closed, true);
    assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'after'), /PHOTO_DISK_BUDGET_REVIEW_REQUIRED/);
  }));
}

test('sqlite: SIGKILL inside the operation marker section is retained across restart and forces review', { timeout: 120_000 }, () => scenario('sqlite', 'sigkill-restart', async (c, recover) => {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'worker.cjs'), c.f.root, c.f.inputHash], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../..') });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`worker timeout: ${stderr}`)), 90_000); child.stdout.on('data', (d) => { if (String(d).includes('inside-marker')) { clearTimeout(t); resolve(); } }); });
  child.kill('SIGKILL');
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const marker = path.join(c.roots.private, 'locks', 'killed-op.lock');
  assert.ok(fs.existsSync(marker));
  // "Restart": a fresh connection and process-independent recovery.
  const report = await recover();
  assert.equal(classOf(report, 'private:locks/killed-op.lock'), 'OPERATION_MARKER_RETAINED');
  assert.equal(report.reviewRequired, true);
  assert.ok(fs.existsSync(marker), 'marker is never removed by recovery');
  evidence.push({ driver: 'sqlite', name: 'sigkill-exit', exit });
}));

test.after(() => {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'recovery-test-evidence.json'), JSON.stringify(evidence, null, 2));
});
