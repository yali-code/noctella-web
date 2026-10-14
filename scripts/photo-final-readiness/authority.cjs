'use strict';
// Final readiness (Package B): TEST-ONLY DevelopmentPhotoAuthority over the PROPOSED ownership schema
// (docs/engineering/proposed-photo-ownership/up.sql), so the real #406 capability (generation-private
// writes, sealing, no-overwrite publication) runs against photo_operations instead of probe tables.
// Disposable databases only; never imported by application code.
const { contract } = require('../photo-ownership-schema/contract.cjs');

const fail = (code) => { throw new Error(code); };
const then = (value, next) => (value instanceof Promise ? value.then(next) : next(value));

/** intents: Map(operationId -> claim intent without owner/nonce/now/ttl). */
function ownershipAuthority(engine, intents) {
  const c = contract(engine);
  const lock = engine.driver === 'postgres' ? ' FOR UPDATE' : '';
  let current = null; // statement runner bound to the open fenced transaction (sequential dev harness only)
  const q = (sql, args) => (current ?? engine.q)(sql, args);
  return {
    execution: engine.driver === 'sqlite' ? 'synchronous' : 'asynchronous',
    contract: c,
    assertRoots: (id, identity) => then(q('INSERT INTO photo_storage_roots(id, identity, created_ms) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING id', [id, identity, Date.now()]),
      () => then(q('SELECT identity FROM photo_storage_roots WHERE id = ?', [id]), (r) => r.length === 1 && r[0].identity === identity)),
    create: (id, owner, nonce, now, ttl) => { const intent = intents.get(id) ?? fail('UNKNOWN_OPERATION_INTENT'); return c.claim({ ...intent, id, owner, nonce, now, ttl }); },
    reclaim: (id, expected, owner, nonce, now, ttl) => c.reclaim(id, expected, owner, nonce, now, ttl),
    /** Fence at every protected boundary: exact generation/owner/nonce, live lease, preparing|sealed. */
    fenced: (t, now, work) => engine.transaction((tq) => then(tq(`SELECT * FROM photo_operations WHERE id = ?${lock}`, [t.id]), (rows) => {
      const row = rows[0];
      if (!row || Number(row.generation) !== t.generation || row.owner !== t.owner || row.nonce !== t.nonce || Number(row.lease_until_ms) <= now || !['preparing', 'sealed'].includes(row.state)) fail('STALE_FENCE');
      current = tq;
      let result;
      try { result = work(); } catch (error) { current = null; throw error; }
      if (result instanceof Promise) return result.finally(() => { current = null; });
      current = null;
      return result;
    })),
    binding: (id) => then(q('SELECT main_key, thumb_key, input_sha256 FROM photo_operations WHERE id = ?', [id]), (r) => (r.length === 1 ? { main: r[0].main_key, thumbnail: r[0].thumb_key, inputHash: r[0].input_sha256 } : fail('BINDING_REQUIRED'))),
    saveSeal: (s) => then(q('INSERT INTO photo_operation_artifacts(id,operation_id,generation,relative_path,main_sha256,thumb_sha256,main_bytes,thumb_bytes,main_dev,main_ino,thumb_dev,thumb_ino,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
      [s.id, s.operation, s.generation, s.relative.split(/[\\/]/).join('/'), s.mainHash, s.thumbHash, s.mainSize, s.thumbSize, s.mainDev, s.mainIno, s.thumbDev, s.thumbIno, Date.now()]),
    () => then(q("UPDATE photo_operations SET state = 'sealed', seal_id = ?, updated_ms = ? WHERE id = ? RETURNING id", [s.id, Date.now(), s.operation]), () => undefined)),
    loadSeal: (id, operation, generation) => then(q('SELECT * FROM photo_operation_artifacts WHERE id = ? AND operation_id = ? AND generation = ?', [id, operation, generation]), (r) => (r.length ? {
      id: r[0].id, operation: r[0].operation_id, generation: Number(r[0].generation), relative: r[0].relative_path,
      mainHash: r[0].main_sha256, thumbHash: r[0].thumb_sha256, mainSize: Number(r[0].main_bytes), thumbSize: Number(r[0].thumb_bytes),
      mainDev: r[0].main_dev, mainIno: r[0].main_ino, thumbDev: r[0].thumb_dev, thumbIno: r[0].thumb_ino,
    } : null)),
  };
}

module.exports = { ownershipAuthority };
