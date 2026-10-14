'use strict';
// P2-2B3D5 (#396/#403/#407): TEST-ONLY adapter for the proposed photo-operation ownership schema
// (docs/engineering/proposed-photo-ownership/up.sql). Disposable SQLite files under
// os.tmpdir()/noctella-photo-fence-* and disposable PostgreSQL schemas only. Never imported by
// application code; never applied by ensureSchema or the PostgreSQL migration runner.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const api = createRequire(path.resolve(__dirname, '../../apps/api/package.json'));

const UP = fs.readFileSync(path.resolve(__dirname, '../../docs/engineering/proposed-photo-ownership/up.sql'), 'utf8');
const DOWN = fs.readFileSync(path.resolve(__dirname, '../../docs/engineering/proposed-photo-ownership/down.sql'), 'utf8');
const LATEST_PG = '0038_background_job_claim_fencing.sql';
const then = (value, next) => (value instanceof Promise ? value.then(next) : next(value));
const fail = (code) => { throw new Error(code); };

function guardRoot(root) {
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'noctella-photo-fence-'))) fail('DISPOSABLE_ROOT_REQUIRED');
}

/** SQLite handle: synchronous; transaction callbacks must never return a Promise. */
function sqliteEngine(file, { busyMs = 5000 } = {}) {
  guardRoot(path.dirname(file));
  const Database = api('better-sqlite3');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${busyMs}`);
  db.pragma('foreign_keys = ON');
  const q = (sql, args = []) => { const st = db.prepare(sql); return st.reader ? st.all(...args) : (st.run(...args), []); };
  return {
    driver: 'sqlite', db, q,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(() => { const r = work(q); if (r instanceof Promise) fail('ASYNC_SQLITE_TRANSACTION_FORBIDDEN'); return r; }).immediate(),
    close: () => db.close(),
  };
}

/** PostgreSQL handle on a disposable schema (search_path pinned by the pool). */
function postgresEngine(pool) {
  const run = (client) => (sql, args = []) => { let i = 0; return client.query(sql.replace(/\?/g, () => `$${++i}`), args).then((r) => r.rows); };
  return {
    driver: 'postgres', pool, q: run(pool),
    exec: (sql) => pool.query(sql),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try { const r = await work(run(client)); await client.query('COMMIT'); return r; }
        catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      } finally { client.release(); }
    },
    close: () => undefined,
  };
}

/** Applies a whole DDL script atomically (both engines support transactional DDL). */
function applyScript(engine, sql, { failAfter = false } = {}) {
  const body = failAfter ? `${sql}\nSELECT * FROM table_that_does_not_exist_p2_2b3d5;` : sql;
  if (engine.driver === 'sqlite') {
    engine.db.exec('BEGIN');
    try { engine.db.exec(body); engine.db.exec('COMMIT'); } catch (error) { engine.db.exec('ROLLBACK'); throw error; }
    return undefined;
  }
  // Multi-statement scripts need the simple query protocol (no parameters) on one client.
  return (async () => {
    const client = await engine.pool.connect();
    try {
      await client.query('BEGIN');
      try { await client.query(body); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    } finally { client.release(); }
  })();
}

const token = (row) => Object.freeze({ id: row.id, generation: Number(row.generation), owner: row.owner, nonce: row.nonce });

function contract(engine) {
  const lock = engine.driver === 'postgres' ? ' FOR UPDATE' : '';
  const readOp = (q, id) => then(q(`SELECT * FROM photo_operations WHERE id = ?${lock}`, [id]), (r) => r[0] ?? null);
  const assertFence = (row, t, now, states) => {
    if (!row || Number(row.generation) !== t.generation || row.owner !== t.owner || row.nonce !== t.nonce || Number(row.lease_until_ms) <= now || !states.includes(row.state)) fail('STALE_FENCE');
  };
  return {
    claim(i) {
      return engine.transaction((q) => then(q(
        `INSERT INTO photo_operations(id,kind,subject_type,subject_id,target_photo_id,main_key,thumb_key,input_sha256,generation,owner,nonce,state,lease_until_ms,created_ms,updated_ms)
         VALUES(?,?,?,?,?,?,?,?,1,?,?,'preparing',?,?,?) ON CONFLICT DO NOTHING RETURNING *`,
        [i.id, i.kind, i.subjectType, i.subjectId, i.targetPhotoId, i.mainKey, i.thumbKey, i.inputSha256, i.owner, i.nonce, i.now + i.ttl, i.now, i.now]),
      (rows) => (rows.length ? then(q("INSERT INTO photo_operation_generations(operation_id,generation,owner,nonce,state,created_ms,updated_ms) VALUES(?,1,?,?,'active',?,?) RETURNING operation_id", [i.id, i.owner, i.nonce, i.now, i.now]), () => token(rows[0])) : null)));
    },
    /** Lease-expiry-gated CAS; nonces are unique per operation, so a reused nonce aborts the whole transaction. */
    reclaim(id, expected, owner, nonce, now, ttl) {
      return engine.transaction((q) => then(q(
        `UPDATE photo_operations SET generation = generation + 1, owner = ?, nonce = ?, state = 'preparing', seal_id = NULL, lease_until_ms = ?, updated_ms = ?
         WHERE id = ? AND generation = ? AND lease_until_ms <= ? AND state IN ('preparing','sealed') RETURNING *`, [owner, nonce, now + ttl, now, id, expected, now]),
      (rows) => (rows.length ? then(q("UPDATE photo_operation_generations SET state = 'superseded', updated_ms = ? WHERE operation_id = ? AND generation = ? RETURNING operation_id", [now, id, expected]),
        () => then(q("INSERT INTO photo_operation_generations(operation_id,generation,owner,nonce,state,created_ms,updated_ms) VALUES(?,?,?,?,'active',?,?) RETURNING operation_id", [id, expected + 1, owner, nonce, now, now]), () => token(rows[0]))) : null)));
    },
    seal(t, now, a) {
      return engine.transaction((q) => then(readOp(q, t.id), (row) => {
        assertFence(row, t, now, ['preparing']);
        if (Number(a.generation) !== t.generation) fail('SEAL_GENERATION_MISMATCH');
        return then(q('INSERT INTO photo_operation_artifacts(id,operation_id,generation,relative_path,main_sha256,thumb_sha256,main_bytes,thumb_bytes,main_dev,main_ino,thumb_dev,thumb_ino,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
          [a.id, t.id, t.generation, a.relativePath, a.mainSha256, a.thumbSha256, a.mainBytes, a.thumbBytes, a.mainDev, a.mainIno, a.thumbDev, a.thumbIno, now]),
        () => then(q("UPDATE photo_operations SET state = 'sealed', seal_id = ?, updated_ms = ? WHERE id = ? RETURNING id", [a.id, now, t.id]), () => a.id));
      }));
    },
    /**
     * The finalization transaction contract. In production it would run inside the existing
     * runWithLockedIntake transaction (intake + product locked). All-or-nothing:
     * fence -> legacy/mixed-version check -> product_photos row + promote outbox event -> committed.
     * A retry after a lost acknowledgement returns the committed result without writing.
     */
    finalize(t, now, f, hooks = {}) {
      return engine.transaction((q) => then(readOp(q, t.id), (row) => {
        if (!row) fail('OPERATION_NOT_FOUND');
        if (row.state === 'committed') {
          return then(q('SELECT id FROM product_photos WHERE id = ?', [row.committed_photo_id]), (photo) => (photo.length && row.committed_photo_id === row.target_photo_id
            ? { status: 'already-committed', photoId: row.committed_photo_id, eventId: row.committed_event_id }
            : then(q("UPDATE photo_operations SET review_reason = 'COMMITTED_PHOTO_MISSING', updated_ms = ? WHERE id = ? RETURNING id", [now, row.id]), () => ({ status: 'review', reason: 'COMMITTED_PHOTO_MISSING' }))));
        }
        if (row.state === 'review') return { status: 'review', reason: row.review_reason };
        assertFence(row, t, now, ['sealed']);
        if (row.seal_id !== f.sealId) fail('SEAL_NOT_CURRENT');
        return then(q('SELECT id FROM product_photos WHERE id = ? OR storage_key IN (?, ?) OR thumbnail_storage_key IN (?, ?) OR filename IN (?, ?)', [row.target_photo_id, row.main_key, row.thumb_key, row.main_key, row.thumb_key, row.main_key, row.thumb_key]), (existing) => {
          if (existing.length) {
            // A legacy/mixed-version writer already claimed this identity: never duplicate or overwrite.
            return then(q("UPDATE photo_operations SET state = 'review', review_reason = 'LEGACY_PHOTO_ROW_EXISTS', updated_ms = ? WHERE id = ? RETURNING id", [now, row.id]),
              () => then(q("UPDATE photo_operation_generations SET state = 'review', updated_ms = ? WHERE operation_id = ? AND generation = ? RETURNING operation_id", [now, row.id, t.generation]), () => ({ status: 'review', reason: 'LEGACY_PHOTO_ROW_EXISTS' })));
          }
          return then(q("INSERT INTO product_photos(id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key,processing_status) VALUES(?,?,?,?,?,'image/webp',?,?,?,?,?,'Processing') RETURNING id",
            [row.target_photo_id, f.productId, `/images/product-photos/${row.main_key}`, `/images/product-photos/${row.thumb_key}`, row.main_key, f.sizeBytes, f.width, f.height, row.main_key, row.thumb_key]),
          () => then(q("INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at) VALUES(?,'product_photo.promote_requested','ProductPhoto',?,?,?,'pending',?) RETURNING id",
            [f.eventId, row.target_photo_id, `product-photo-promote:${row.target_photo_id}`, JSON.stringify({ photoId: row.target_photo_id, storageKey: row.main_key, thumbnailStorageKey: row.thumb_key }), new Date(now).toISOString()]),
          () => {
            if (hooks.failAfterInserts) fail('INJECTED_FAILURE_BEFORE_COMMIT');
            return then(q("UPDATE photo_operations SET state = 'committed', committed_photo_id = ?, committed_event_id = ?, updated_ms = ? WHERE id = ? RETURNING id", [row.target_photo_id, f.eventId, now, row.id]),
              () => then(q("UPDATE photo_operation_generations SET state = 'committed', updated_ms = ? WHERE operation_id = ? AND generation = ? RETURNING operation_id", [now, row.id, t.generation]), () => ({ status: 'committed', photoId: row.target_photo_id, eventId: f.eventId })));
          }));
        });
      }));
    },
    read: (id) => then(engine.q('SELECT * FROM photo_operations WHERE id = ?', [id]), (r) => r[0] ?? null),
    /** Read-only reference source for #409 classification: canonical keys owned by any operation state. */
    references: () => then(engine.q('SELECT id, state, main_key, thumb_key FROM photo_operations'), (rows) => rows.flatMap((r) => [[r.main_key, `photo_operations.${r.state}:${r.id}`], [r.thumb_key, `photo_operations.${r.state}:${r.id}`]])),
    /** Bytes of recorded seals that are not the committed publication (superseded or pending): retained, review-only. */
    retainedSealBytes: () => then(engine.q("SELECT COALESCE(SUM(a.main_bytes + a.thumb_bytes), 0) AS bytes FROM photo_operation_artifacts a JOIN photo_operations o ON o.id = a.operation_id WHERE NOT (o.state = 'committed' AND o.seal_id = a.id)"), (r) => Number(r[0].bytes)),
  };
}

module.exports = { UP, DOWN, LATEST_PG, sqliteEngine, postgresEngine, applyScript, contract, guardRoot };
