import type Database from "better-sqlite3";
import type { PoolClient } from "pg";

/**
 * FAZ A / #424: caller-owned transaction COMMIT fence.
 *
 * Caller MUST have inserted photo + outbox in the same open transaction and
 * MUST rollback the entire transaction on any error from this function.
 * No transaction is started or committed here; no filesystem work is authorized.
 * This is a building block, NOT production W2/W4 writer adoption.
 */
export interface PhotoCommitFenceProof {
  operationId: string;
  generation: number;
  owner: string;
  nonce: string;
  sealId: string;
  photoId: string;
  eventId: string;
}

function validate(p: PhotoCommitFenceProof): void {
  if (!p || !Number.isSafeInteger(p.generation) || p.generation < 1 ||
      ![p.operationId, p.owner, p.nonce, p.sealId, p.photoId, p.eventId]
        .every(value => typeof value === "string" && value.length > 0 && value.length <= 256))
    throw new Error("PHOTO_COMMIT_PROOF_INVALID");
}

/** Synchronous SQLite implementation; invoke inside better-sqlite3 transaction. */
export function commitSqlitePhotoOperationFenced(tx: Database.Database, p: PhotoCommitFenceProof): void {
  validate(p);
  const result = tx.prepare(`UPDATE photo_operations
    SET state = 'committed', committed_photo_id = ?, committed_event_id = ?,
        updated_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE id = ? AND generation = ? AND owner = ? AND nonce = ?
      AND state = 'sealed' AND seal_id = ? AND target_photo_id = ?
      AND lease_until_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)`)
    .run(p.photoId, p.eventId, p.operationId, p.generation, p.owner,
      p.nonce, p.sealId, p.photoId);
  if (result.changes !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST");
  const history = tx.prepare(`UPDATE photo_operation_generations
    SET state = 'committed', updated_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE operation_id = ? AND generation = ? AND owner = ? AND nonce = ?
      AND state = 'active'`).run(p.operationId, p.generation, p.owner, p.nonce);
  if (history.changes !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST");
}

/** PostgreSQL implementation; client MUST already be in the caller's transaction. */
export async function commitPostgresPhotoOperationFenced(tx: PoolClient, p: PhotoCommitFenceProof): Promise<void> {
  validate(p);
  const result = await tx.query(`UPDATE photo_operations
    SET state = 'committed', committed_photo_id = $1, committed_event_id = $2,
        updated_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    WHERE id = $3 AND generation = $4 AND owner = $5 AND nonce = $6
      AND state = 'sealed' AND seal_id = $7 AND target_photo_id = $8
      AND lease_until_ms > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    RETURNING id`, [
      p.photoId, p.eventId, p.operationId, p.generation, p.owner,
      p.nonce, p.sealId, p.photoId,
    ]);
  if (result.rowCount !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST");
  const history = await tx.query(`UPDATE photo_operation_generations
    SET state = 'committed', updated_ms = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
    WHERE operation_id = $1 AND generation = $2 AND owner = $3
      AND nonce = $4 AND state = 'active' RETURNING operation_id`,
    [p.operationId, p.generation, p.owner, p.nonce]);
  if (history.rowCount !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST");
}
