'use strict';
// P2-2B3D5 (#396/#403/#407): proposed ownership schema + transaction contract on disposable
// SQLite and PostgreSQL. Run: node --import tsx --test scripts/photo-ownership-schema/ownership.test.cjs
// PostgreSQL cases need POSTGRES_TEST_DATABASE_URL (a disposable local database, as in CI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
Object.assign(process.env, { NODE_ENV: 'test', PRODUCT_PHOTO_DISK_STAGING_ENABLED: 'true' });
const { UP, DOWN, LATEST_PG, sqliteEngine, postgresEngine, applyScript, contract, int, decode } = require('./contract.cjs');
const { ensureSchema } = require('../../apps/api/src/db/migrate.ts');
const { runDevelopmentPhotoRecovery, collectSqlitePhotoReferences, collectPostgresPhotoReferences } = require('../../apps/api/src/services/developmentPhotoRecovery.ts');
const { DevelopmentPhotoDiskBudget, PHOTO_DISK_PROFILES } = require('../../apps/api/src/services/developmentPhotoDiskBudget.ts');

const pgSkip = !process.env.POSTGRES_TEST_DATABASE_URL && 'POSTGRES_TEST_DATABASE_URL not configured';
const evidence = [];
const TTL = 1000;

async function env(driver, { up = true, through = LATEST_PG } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-'));
  let engine, h;
  try {
    if (driver === 'sqlite') {
      engine = sqliteEngine(path.join(root, 'app.sqlite')); ensureSchema(engine.db);
      if (!up) {
        // Since 0040 is registered, application startup (ensureSchema) creates the ownership tables.
        // The migration-under-test baseline is the pre-ownership schema: prove they were created
        // empty by startup, then remove exactly those four tables (PostgreSQL stops at 0038 instead).
        for (const t of ['photo_operation_artifacts', 'photo_operation_generations', 'photo_operations', 'photo_storage_roots']) {
          if (Number(engine.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n) !== 0) throw new Error(`startup table ${t} not empty`);
          engine.db.exec(`DROP TABLE ${t}`);
        }
      }
    }
    else { h = await require('../../apps/api/tests/postgresTestDb.ts').createPostgresTestDb(through); engine = postgresEngine(h.pool); }
    if (up) await applyScript(engine, UP);
    await engine.q('INSERT INTO products(id,sku,title,slug,type,status) VALUES(?,?,?,?,?,?) RETURNING id', ['prod-1', 'SKU-1', 'Synthetic', 'synthetic-1', 'unique_item', 'draft']);
  } catch (error) { engine?.close(); await h?.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
  const x = { root, engine, h, c: contract(engine), close: async () => { x.engine.close(); await h?.close(); fs.rmSync(root, { recursive: true, force: true }); } };
  return x;
}
const intent = (over = {}) => ({ id: 'ai-finalize-intake-1-photo-1', kind: 'ai_finalize', subjectType: 'ai_intake_photos', subjectId: 'iph-1', targetPhotoId: 'prod-1-photo-1', mainKey: 'prod-1-photo-1.webp', thumbKey: 'prod-1-photo-1-thumb.webp', inputSha256: 'a'.repeat(64), owner: 'w1', nonce: 'n1', now: 100, ttl: TTL, ...over });
const artifact = (gen, n = 'x') => ({ id: `seal-g${gen}-${n}`, generation: gen, relativePath: `op/g${gen}/${n}/sealed`, mainSha256: 'b'.repeat(64), thumbSha256: 'c'.repeat(64), mainBytes: 100, thumbBytes: 20, mainDev: '1', mainIno: String(10 + gen), thumbDev: '1', thumbIno: String(20 + gen) });
const finalizeInput = (sealId, eventId = 'evt-1') => ({ sealId, productId: 'prod-1', sizeBytes: 100, width: 32, height: 24, eventId });
const count = async (e, table) => Number((await e.q(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
const columns = async (e, table) => (e.driver === 'sqlite' ? e.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => `${r.name}:${r.type}:${r.notnull}:${r.dflt_value}`) : (await e.q('SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position', [table])).map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}:${r.column_default}`));
const hasTable = async (e, table) => (e.driver === 'sqlite' ? e.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").all(table).length > 0 : (await e.q('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?', [table])).length > 0);

test('BIGINT boundary decoding is exact for both drivers (int8 strings, numbers, bigint) and fails closed', () => {
  // node-postgres returns int8 as a string; better-sqlite3 returns a number.
  for (const value of ['2', 2, 2n, '9007199254740991', '-5']) assert.equal(int(value), Number(value));
  for (const value of ['9007199254740993', '2.5', '01', '', ' 2', null, undefined, 'abc', 2.5]) assert.throws(() => int(value), /PHOTO_BIGINT_OUT_OF_RANGE/, String(value));
  const row = decode({ id: 'op', generation: '2', lease_until_ms: '2200', created_ms: '100', updated_ms: '1200', owner: 'w2' });
  assert.deepEqual([row.generation, row.lease_until_ms, row.created_ms, row.updated_ms], [2, 2200, 100, 1200]);
  assert.equal(decode(null), null);
});

test('registered SQLite schema.sql block and PostgreSQL 0040 are identical to the reviewed DDL', () => {
  const norm = (sql) => sql.replace(/\r\n/g, '\n').replace(/--[^\n]*\n/g, '').replace(/\s+/g, ' ').trim();
  const schema = fs.readFileSync(path.resolve(__dirname, '../../apps/api/src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('-- Photo-operation ownership');
  const end = schema.indexOf('-- Stage 5 #424: additive W2 durable intent registry.', start);
  assert.ok(start >= 0 && end > start, '0040 ownership block must have explicit 0041 boundary');
  const registered = norm(schema.slice(start, end));
  const pg = norm(fs.readFileSync(path.resolve(__dirname, '../../apps/api/src/db/postgres-migrations/0040_photo_operation_ownership.sql'), 'utf8'));
  assert.equal(registered, norm(UP));
  assert.equal(pg, norm(UP));
});

for (const driver of ['sqlite', 'postgres']) {
  const opts = { skip: driver === 'postgres' && pgSkip, timeout: 120_000 };
  const withEnv = (fn, o) => async () => { const x = await env(driver, o); try { await fn(x); } finally { await x.close(); } };

  test(`${driver}: proposed DDL is additive, idempotent, atomic on failure and reversible`, opts, withEnv(async ({ engine }) => {
    assert.equal(await hasTable(engine, 'photo_operations'), false, 'baseline is the pre-ownership schema');
    const before = { photos: await columns(engine, 'product_photos'), outbox: await columns(engine, 'outbox_events') };
    await assert.rejects(async () => (applyScript(engine, UP, { failAfter: true })));
    assert.equal(await hasTable(engine, 'photo_operations'), false, 'a failed migration leaves no partial schema');
    await applyScript(engine, UP); await applyScript(engine, UP);
    assert.equal(await hasTable(engine, 'photo_operations'), true);
    assert.deepEqual({ photos: await columns(engine, 'product_photos'), outbox: await columns(engine, 'outbox_events') }, before, 'existing tables unchanged');
    await applyScript(engine, DOWN);
    for (const t of ['photo_operations', 'photo_operation_generations', 'photo_operation_artifacts', 'photo_storage_roots']) assert.equal(await hasTable(engine, t), false);
    assert.equal(await count(engine, 'products'), 1, 'rollback leaves application data intact');
    await applyScript(engine, UP);
    evidence.push({ driver, name: 'ddl', columnsBefore: before });
  }, { up: false }));


  test(`${driver}: 0041 intent dependency rolls back before 0040, atomically, and re-applies`, opts, withEnv(async ({ engine }) => {
    // SQLite startup has 0040 + 0041; PostgreSQL fixture starts at registered 0041.
    assert.equal(await hasTable(engine, 'photo_w2_upload_intents'), true, '0041 must exist before rollback');
    const bind = async (op, token) => {
      await engine.q(`INSERT INTO photo_operations (id, kind, subject_type, subject_id, target_photo_id, main_key, thumb_key, input_sha256, generation, owner, nonce, state, lease_until_ms, created_ms, updated_ms)
        VALUES (?, 'product_upload', 'w2_request', ?, ?, ?, ?, ?, 1, 'o', ?, 'committed', 0, 0, 0) RETURNING id`,
        [op, token, `${op}-photo`, `${op}.webp`, `${op}-thumb.webp`, 'a'.repeat(64), `${op}-nonce`]);
      await engine.q("INSERT INTO photo_w2_upload_intents (token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id, created_ms) VALUES (?, 't', 'a', 'prod-1', ?, '', ?, 0) RETURNING token",
        [token, 'a'.repeat(64), op]);
    };
    await bind('op-457-1', 'token-457-000000001');
    await applyScript(engine, DOWN); // isolated disposable database, same transaction for all DDL
    for (const table of ['photo_w2_upload_intents', 'photo_operation_artifacts', 'photo_operation_generations', 'photo_operations', 'photo_storage_roots'])
      assert.equal(await hasTable(engine, table), false, `${table} must be removed`);
    assert.equal(await count(engine, 'products'), 1, 'application products must survive');
    await applyScript(engine, UP);
    await applyScript(engine, fs.readFileSync(path.resolve(__dirname, '../../apps/api/src/db/postgres-migrations/0041_photo_w2_upload_intents.sql'), 'utf8'));
    await bind('op-457-2', 'token-457-000000002');
    assert.equal(await count(engine, 'photo_w2_upload_intents'), 1, 'restored dependency schema must remain usable');
  }, { through: '0041_photo_w2_upload_intents.sql' }));

  test(`${driver}: atomic finalize, idempotent retry after a lost acknowledgement, rollback on failure`, opts, withEnv(async ({ engine, c }) => {
    const t = await c.claim(intent());
    const sealId = await c.seal(t, 101, artifact(1));
    await assert.rejects(async () => (c.finalize(t, 102, finalizeInput(sealId), { failAfterInserts: true })), /INJECTED_FAILURE_BEFORE_COMMIT/);
    assert.equal(await count(engine, 'product_photos'), 0); assert.equal(await count(engine, 'outbox_events'), 0);
    assert.equal((await c.read(t.id)).state, 'sealed', 'rolled back as a unit');
    const first = await c.finalize(t, 103, finalizeInput(sealId));
    assert.equal(first.status, 'committed');
    // Acknowledgement "lost": the caller retries; nothing is written twice.
    const again = await c.finalize(t, 104, finalizeInput(sealId, 'evt-retry'));
    assert.deepEqual(again, { status: 'already-committed', photoId: 'prod-1-photo-1', eventId: 'evt-1' });
    assert.equal(await count(engine, 'product_photos'), 1); assert.equal(await count(engine, 'outbox_events'), 1);
    const [photo] = await engine.q('SELECT url, thumbnail_url, storage_key, thumbnail_storage_key, processing_status FROM product_photos WHERE id = ?', ['prod-1-photo-1']);
    assert.deepEqual(photo, { url: '/images/product-photos/prod-1-photo-1.webp', thumbnail_url: '/images/product-photos/prod-1-photo-1-thumb.webp', storage_key: 'prod-1-photo-1.webp', thumbnail_storage_key: 'prod-1-photo-1-thumb.webp', processing_status: 'Processing' });
    evidence.push({ driver, name: 'finalize', first, again });
  }));

  test(`${driver}: concurrent claims and binding uniqueness admit exactly one owner`, opts, withEnv(async ({ root, engine, c }) => {
    if (driver === 'postgres') {
      const results = await Promise.all([1, 2, 3, 4].map((i) => c.claim(intent({ owner: `w${i}`, nonce: `n${i}` }))));
      assert.equal(results.filter(Boolean).length, 1);
    } else {
      const other = sqliteEngine(path.join(root, 'app.sqlite'), { busyMs: 100 });
      try {
        engine.db.prepare('BEGIN IMMEDIATE').run();
        assert.throws(() => contract(other).claim(intent({ owner: 'w2', nonce: 'n2' })), /SQLITE_BUSY|database is locked/);
        engine.db.prepare('ROLLBACK').run();
        assert.ok(await contract(other).claim(intent({ owner: 'w2', nonce: 'n2' })));
        assert.equal(await c.claim(intent()), null);
      } finally { other.close(); }
    }
    assert.equal(await c.claim(intent({ id: 'other-op', subjectId: 'iph-2', targetPhotoId: 'p-2', thumbKey: 'p-2-thumb.webp' })), null, 'main key already bound');
    assert.equal(await c.claim(intent({ id: 'other-op', mainKey: 'p-2.webp', thumbKey: 'p-2-thumb.webp', targetPhotoId: 'p-2' })), null, 'subject already bound');
    assert.equal(await count(engine, 'photo_operations'), 1);
  }));

  test(`${driver}: lease-gated reclaim, stale tokens and nonce reuse (ABA) are rejected`, opts, withEnv(async ({ c }) => {
    const t1 = await c.claim(intent());
    await c.seal(t1, 101, artifact(1));
    assert.equal(await c.reclaim(t1.id, 1, 'w2', 'n2', 500, TTL), null, 'active lease cannot be reclaimed (no PID/age grant)');
    const t2 = await c.reclaim(t1.id, 1, 'w2', 'n2', 1200, TTL);
    assert.equal(t2.generation, 2);
    await assert.rejects(async () => (c.seal(t1, 1201, artifact(1, 'late'))), /STALE_FENCE/);
    await assert.rejects(async () => (c.finalize(t1, 1201, finalizeInput('seal-g1-x'))), /STALE_FENCE/);
    assert.equal(await c.reclaim(t1.id, 1, 'w3', 'n3', 5000, TTL), null, 'CAS on the expected generation');
    await assert.rejects(async () => (c.reclaim(t1.id, 2, 'w3', 'n1', 5000, TTL)), /UNIQUE|unique|duplicate/i, 'nonce of generation 1 cannot return');
    assert.equal((await c.read(t1.id)).generation, 2, 'failed reclaim rolled back');
    const s2 = await c.seal(t2, 1202, artifact(2));
    await assert.rejects(async () => (c.finalize(t2, 1203, finalizeInput('seal-g1-x'))), /SEAL_NOT_CURRENT/);
    assert.equal((await c.finalize(t2, 1203, finalizeInput(s2))).status, 'committed');
    assert.equal(await c.retainedSealBytes(), 120, 'superseded generation-1 seal stays retained and counted');
  }));

  test(`${driver}: historical/outbox-only references and a deleted committed photo force review, never re-creation`, opts, withEnv(async ({ engine, c }) => {
    const t = await c.claim(intent());
    const s = await c.finalize(t, 102, finalizeInput(await c.seal(t, 101, artifact(1))));
    assert.equal(s.status, 'committed');
    await engine.q('DELETE FROM product_photos WHERE id = ? RETURNING id', ['prod-1-photo-1']);
    await engine.q("INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id",
      ['evt-del', 'product_photo.delete_requested', 'ProductPhoto', 'prod-1-photo-1', 'product-photo-delete:prod-1-photo-1', JSON.stringify({ photoId: 'prod-1-photo-1', storageKey: 'prod-1-photo-1.webp', thumbnailStorageKey: 'prod-1-photo-1-thumb.webp' }), 'completed', new Date(103).toISOString()]);
    assert.deepEqual(await c.finalize(t, 104, finalizeInput('seal-g1-x', 'evt-2')), { status: 'review', reason: 'COMMITTED_PHOTO_MISSING' });
    assert.equal(await count(engine, 'product_photos'), 0, 'a deleted photo is never resurrected');
    const refs = await c.references();
    assert.ok(refs.some(([key, source]) => key === 'prod-1-photo-1.webp' && source.startsWith('photo_operations.committed')));
  }));

  test(`${driver}: mixed-version legacy writer row moves the operation to review without duplicates`, opts, withEnv(async ({ engine, c }) => {
    const t = await c.claim(intent());
    const sealId = await c.seal(t, 101, artifact(1));
    await engine.q("INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      ['legacy-photo', 'prod-1', '/images/product-photos/prod-1-photo-1.webp', '/images/product-photos/legacy-thumb.webp', 'prod-1-photo-1.webp', 'image/webp', 1, 1, 1, 'prod-1-photo-1.webp', 'legacy-thumb.webp']);
    assert.deepEqual(await c.finalize(t, 102, finalizeInput(sealId)), { status: 'review', reason: 'LEGACY_PHOTO_ROW_EXISTS' });
    assert.equal(await count(engine, 'product_photos'), 1); assert.equal(await count(engine, 'outbox_events'), 0);
    assert.equal((await c.read(t.id)).state, 'review');
    assert.equal((await c.finalize(t, 103, finalizeInput(sealId))).status, 'review', 'review is terminal until an operator acts');
  }));

  test(`${driver}: pending publication is classified as referenced; ENOSPC keeps the operation sealed and closes the budget`, opts, withEnv(async ({ root, engine, c }) => {
    const canonical = path.join(root, 'canonical'); fs.mkdirSync(canonical);
    const t = await c.claim(intent());
    const sealId = await c.seal(t, 101, artifact(1));
    const budget = new DevelopmentPhotoDiskBudget({ budgetRoot: path.join(root, 'budget'), accountedRoots: [canonical], budgetBytes: 1024 ** 3, freeSpaceFloorBytes: 0 });
    // Publication fails with ENOSPC before the finalize transaction: nothing is committed.
    const publish = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    try { publish(); } catch (error) { assert.equal(error.code, 'ENOSPC'); budget.close('ENOSPC during canonical publication'); }
    assert.equal((await c.read(t.id)).state, 'sealed');
    assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.d1CapabilityDeterministic, 'next'), /PHOTO_DISK_BUDGET_REVIEW_REQUIRED/);
    // Retry after operator review: the pair is published, then a crash before finalize leaves it pending.
    fs.writeFileSync(path.join(canonical, 'prod-1-photo-1.webp'), 'main'); fs.writeFileSync(path.join(canonical, 'prod-1-photo-1-thumb.webp'), 'thumb');
    const base = driver === 'sqlite' ? () => collectSqlitePhotoReferences(engine.db) : () => collectPostgresPhotoReferences(engine.pool);
    const references = async () => { const s = await base(); for (const [key, source] of await c.references()) s.canonical.set(key, [...(s.canonical.get(key) ?? []), source]); return s; };
    const { report } = await runDevelopmentPhotoRecovery({ roots: { canonical }, reviewDir: path.join(root, 'review'), references });
    assert.deepEqual(report.artifacts.map((a) => [a.path, a.class, a.reasons[0]]).sort(), [['prod-1-photo-1-thumb.webp', 'REFERENCED', `photo_operations.sealed:${t.id}`], ['prod-1-photo-1.webp', 'REFERENCED', `photo_operations.sealed:${t.id}`]]);
    assert.equal(report.reviewRequired, false);
    assert.equal((await c.finalize(t, 102, finalizeInput(sealId))).status, 'committed');
    evidence.push({ driver, name: 'pending-publication-classification', report: report.artifacts });
  }));
}

test('sqlite: SIGKILL between canonical publication and the finalize transaction, then restart', { timeout: 120_000 }, async () => {
  const x = await env('sqlite');
  try {
    for (const d of ['canonical', 'sealed']) fs.mkdirSync(path.join(x.root, d));
    fs.writeFileSync(path.join(x.root, 'sealed', 'main.webp'), 'sealed-main-bytes'); fs.writeFileSync(path.join(x.root, 'sealed', 'thumb.webp'), 'sealed-thumb-bytes');
    x.engine.close();
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'worker.cjs'), x.root, JSON.stringify(intent()), JSON.stringify(artifact(1))], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../..') });
    let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`worker timeout ${stderr}`)), 90_000); child.stdout.on('data', (d) => { if (String(d).includes('published-before-finalize')) { clearTimeout(timer); resolve(); } }); });
    child.kill('SIGKILL');
    const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const proof = (f) => { const s = fs.statSync(f, { bigint: true }); return { ino: s.ino.toString(), sha: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') }; };
    const before = proof(path.join(x.root, 'canonical', 'prod-1-photo-1.webp'));
    // Restart: fresh connection and contract.
    x.engine = sqliteEngine(path.join(x.root, 'app.sqlite')); x.c = contract(x.engine);
    const row = await x.c.read(intent().id);
    assert.deepEqual([row.state, row.generation], ['sealed', 1]);
    assert.equal(await count(x.engine, 'product_photos'), 0, 'the killed process never committed');
    assert.equal(await x.c.reclaim(row.id, 1, 'w2', 'n2', 500, TTL), null, 'no reclaim before lease expiry');
    const t2 = await x.c.reclaim(row.id, 1, 'w2', 'n2', 2000, TTL);
    const s2 = await x.c.seal(t2, 2001, artifact(2));
    assert.equal((await x.c.finalize(t2, 2002, finalizeInput(s2))).status, 'committed');
    assert.deepEqual(proof(path.join(x.root, 'canonical', 'prod-1-photo-1.webp')), before, 'published bytes and inode preserved');
    assert.equal(await x.c.retainedSealBytes(), 120, 'the killed generation seal is retained and counted');
    evidence.push({ driver: 'sqlite', name: 'sigkill-restart', exit, canonical: before });
  } finally { await x.close(); }
});

test.after(() => {
  const dest = process.env.NOCTELLA_OWNERSHIP_EVIDENCE_DIR;
  if (dest) { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'ownership-test-evidence.json'), JSON.stringify(evidence, null, 2)); }
});
