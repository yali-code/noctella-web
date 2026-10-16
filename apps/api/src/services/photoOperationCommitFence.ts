import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
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

/**
 * Execute the ownership CAS using the SAME Drizzle transaction handle as the
 * existing canonical photo+promotion-outbox writer. SQLite stays synchronous;
 * PostgreSQL resolves only after both updates complete. The caller must throw
 * through its transaction callback on any failure (never swallow this error).
 */
export function commitDrizzlePhotoOperationFenced(
  tx: any,
  execution: "synchronous" | "asynchronous",
  p: PhotoCommitFenceProof,
): void | Promise<void> {
  validate(p);
  const now = execution === "synchronous"
    ? sql.raw("CAST(unixepoch('subsec') * 1000 AS INTEGER)")
    : sql.raw("(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint");
  const run = (statement: ReturnType<typeof sql>): any =>
    execution === "synchronous" ? tx.all(statement) : tx.execute(statement).then((result: { rows: unknown[] }) => result.rows);
  const operation = sql`UPDATE photo_operations
    SET state = 'committed', committed_photo_id = ${p.photoId},
        committed_event_id = ${p.eventId}, updated_ms = ${now}
    WHERE id = ${p.operationId} AND generation = ${p.generation}
      AND owner = ${p.owner} AND nonce = ${p.nonce}
      AND state = 'sealed' AND seal_id = ${p.sealId}
      AND target_photo_id = ${p.photoId} AND lease_until_ms > ${now}
    RETURNING id`;
  const generation = sql`UPDATE photo_operation_generations
    SET state = 'committed', updated_ms = ${now}
    WHERE operation_id = ${p.operationId} AND generation = ${p.generation}
      AND owner = ${p.owner} AND nonce = ${p.nonce} AND state = 'active'
    RETURNING operation_id`;
  const verify = (rows: unknown[]) => {
    if (rows.length !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST");
  };
  if (execution === "synchronous") {
    verify(run(operation));
    verify(run(generation));
    return;
  }
  return (run(operation) as Promise<unknown[]>).then(rows => {
    verify(rows);
    return run(generation) as Promise<unknown[]>;
  }).then(verify);
}
