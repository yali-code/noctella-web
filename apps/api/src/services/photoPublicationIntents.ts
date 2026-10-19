/**
 * Stage 5 F2 WP1 (#472): runtime publication-intent foundation. NOT WIRED: no owner, route or flag uses it yet, so
 * the vulnerable runtime paths (owners linking worker-owned inodes under the lease-only fence) are unchanged.
 *
 * Adapted from the offline Contract 1 proof. A publication intent is NON-EXPIRING authority for exactly one
 * operation generation and seal, held by one executor (epoch, token, identity):
 * - T1 and guarded reclaim both take the photo_operations row lock (PostgreSQL FOR UPDATE, SQLite BEGIN IMMEDIATE via
 *   inOwnershipTransaction) BEFORE reading the intent, so they are totally ordered.
 * - While an intent is 'authorized', guarded reclaim refuses to supersede the generation (never on lease expiry).
 * - Epoch n -> n+1 transfer requires a persisted exit record for the exact epoch-n executor identity.
 * - The intent-authorized commit fence replaces ONLY the lease predicate and binds the full authority tuple.
 *
 * TRUSTED CALLER BOUNDARY: persistAuthenticatedExecutorExitSteps only RECORDS an exit that the caller has already
 * authenticated (e.g. the Step 2 supervisor completion bound to its observed exit). It authenticates nothing and must
 * never be called on a lease expiry, timeout, missing heartbeat or worker-supplied PID. Runtime process
 * authentication is later work (WP5).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import {
  claimExistingOperation, inOwnershipTransaction, nowMs, reviewSteps,
  type OperationClaim, type OwnedOperation, type OwnershipDriver, type Rows,
} from "./photoOperationAuthority";

export interface PublicationExecutor { token: string; executorIdentity: string }
export interface ArtifactIdentity { sha256: string; dev: string; ino: string }
export interface PublicationAuthority {
  operationId: string; generation: number; owner: string; nonce: string; sealId: string;
  epoch: number; token: string; executorIdentity: string; mainKey: string; thumbKey: string;
  identity: { main: ArtifactIdentity; thumb: ArtifactIdentity };
}
export type IntentAcquisition =
  | { kind: "own"; authority: PublicationAuthority }
  | { kind: "held-by-other" }
  | { kind: "rejected"; reason: string }
  | { kind: "terminal"; state: string };
export type AuthorityTransfer = { kind: "own"; authority: PublicationAuthority } | { kind: "no-exit-record" | "lost" | "terminal" };

/** Explicit intent columns (no SELECT *). */
const INTENT_COLUMNS = sql.raw("operation_id, generation, owner, nonce, seal_id, main_key, thumb_key, main_sha256, main_dev, main_ino, thumb_sha256, thumb_dev, thumb_ino, executor_epoch, executor_token, executor_identity, state");
const lockClause = (driver: OwnershipDriver) => sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
const lockOperationRow = (driver: OwnershipDriver, operationId: string) => sql`SELECT id FROM photo_operations WHERE id = ${operationId}${lockClause(driver)}`;

/** BIGINT values arrive as strings on PostgreSQL. Authority decisions never use a lossy conversion: fail closed. */
export function exactPositiveInteger(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || String(n) !== String(value).trim()) throw new Error("PHOTO_PUBLICATION_INTEGER_INVALID");
  return n;
}
/** Stored value must itself be exact (a driver-rounded or out-of-range value throws) before it is compared. */
const sameInteger = (stored: unknown, expected: number) => exactPositiveInteger(stored) === exactPositiveInteger(expected);

function toAuthority(row: Record<string, any>): PublicationAuthority {
  return {
    operationId: row.operation_id, generation: exactPositiveInteger(row.generation), owner: row.owner, nonce: row.nonce, sealId: row.seal_id,
    epoch: exactPositiveInteger(row.executor_epoch), token: row.executor_token, executorIdentity: row.executor_identity,
    mainKey: row.main_key, thumbKey: row.thumb_key,
    identity: {
      main: { sha256: row.main_sha256, dev: String(row.main_dev), ino: String(row.main_ino) },
      thumb: { sha256: row.thumb_sha256, dev: String(row.thumb_dev), ino: String(row.thumb_ino) },
    },
  };
}

function classify(row: Record<string, any>, op: OwnedOperation, sealId: string, me: PublicationExecutor): IntentAcquisition {
  if (row.state !== "authorized") return { kind: "terminal", state: row.state };
  if (!sameInteger(row.generation, op.generation) || row.owner !== op.owner || row.nonce !== op.nonce || row.seal_id !== sealId)
    return { kind: "rejected", reason: "intent bound to another generation or seal" };
  // A lost-acknowledgement retry is the SAME executor: same token AND same identity.
  if (row.executor_token === me.token && row.executor_identity === me.executorIdentity) return { kind: "own", authority: toAuthority(row) };
  return { kind: "held-by-other" };
}

/** T1 steps (one transaction). Admission still requires the current sealed generation and a live DB-clock lease. */
export function* acquirePublicationIntentSteps(driver: OwnershipDriver, op: OwnedOperation, sealId: string, me: PublicationExecutor): Generator<SQL, IntentAcquisition, Rows> {
  const now = nowMs(driver);
  yield lockOperationRow(driver, op.id);
  const [existing] = yield sql`SELECT ${INTENT_COLUMNS} FROM photo_publication_intents WHERE operation_id = ${op.id}`;
  if (existing) return classify(existing, op, sealId, me);
  const [current] = yield sql`SELECT id FROM photo_operations WHERE id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner}
    AND nonce = ${op.nonce} AND state = 'sealed' AND seal_id = ${sealId} AND lease_until_ms > ${now}`;
  if (!current) return { kind: "rejected", reason: "not the current sealed generation with a live lease" };
  const [seal] = yield sql`SELECT main_sha256, main_dev, main_ino, thumb_sha256, thumb_dev, thumb_ino FROM photo_operation_artifacts
    WHERE id = ${sealId} AND operation_id = ${op.id} AND generation = ${op.generation}`;
  if (!seal) return { kind: "rejected", reason: "seal not found" };
  const [row] = yield sql`INSERT INTO photo_publication_intents (operation_id, generation, owner, nonce, seal_id, main_key, thumb_key,
    main_sha256, main_dev, main_ino, thumb_sha256, thumb_dev, thumb_ino, executor_epoch, executor_token, executor_identity, state, created_ms, updated_ms)
    VALUES (${op.id}, ${op.generation}, ${op.owner}, ${op.nonce}, ${sealId}, ${op.mainKey}, ${op.thumbKey},
    ${seal.main_sha256}, ${String(seal.main_dev)}, ${String(seal.main_ino)}, ${seal.thumb_sha256}, ${String(seal.thumb_dev)}, ${String(seal.thumb_ino)},
    1, ${me.token}, ${me.executorIdentity}, 'authorized', ${now}, ${now}) RETURNING ${INTENT_COLUMNS}`;
  return { kind: "own", authority: toAuthority(row) };
}

/**
 * True only for a unique/primary-key violation identified by its driver code, anywhere in the cause chain: drizzle's
 * PostgreSQL session wraps driver errors in DrizzleQueryError (code on `cause`), better-sqlite3 throws SqliteError
 * directly. Messages are never matched (they embed query parameters); other constraint failures are not unique.
 */
export function publicationUniqueViolation(error: unknown): boolean {
  for (let e: any = error, depth = 0; e && depth < 5; e = e.cause, depth++)
    if (e.code === "23505" || e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  return false;
}

/**
 * T1 with unique-violation recovery in a FRESH transaction, started only after the failed one has rolled back (the
 * aborted one is never queried again), following the repository's W2 claim convention. A violation without an
 * intent for this operation (e.g. a token or seal already bound elsewhere) fails closed.
 */
export async function acquirePublicationIntent(db: DbClient, driver: OwnershipDriver, op: OwnedOperation, sealId: string, me: PublicationExecutor): Promise<IntentAcquisition> {
  try { return await inOwnershipTransaction(db, driver, () => acquirePublicationIntentSteps(driver, op, sealId, me)); }
  catch (error) {
    if (!publicationUniqueViolation(error)) throw error;
    return inOwnershipTransaction(db, driver, function* (): Generator<SQL, IntentAcquisition, Rows> {
      yield lockOperationRow(driver, op.id);
      const [winner] = yield sql`SELECT ${INTENT_COLUMNS} FROM photo_publication_intents WHERE operation_id = ${op.id}`;
      return winner ? classify(winner, op, sealId, me) : { kind: "rejected", reason: "unique violation without an intent for this operation" };
    });
  }
}

/**
 * Guarded reclaim (inside the caller's claim transaction, after any caller-specific locks): lock the operation row,
 * refuse while an intent is authorized, otherwise delegate to the unchanged claimExistingOperation.
 */
export function* guardedReclaimSteps(driver: OwnershipDriver, operationId: string, ttl: number): Generator<SQL, OperationClaim, Rows> {
  yield lockOperationRow(driver, operationId);
  const [intent] = yield sql`SELECT state FROM photo_publication_intents WHERE operation_id = ${operationId}`;
  if (intent?.state === "authorized") return { kind: "in-progress" };
  return yield* claimExistingOperation(driver, operationId, ttl);
}

/** TRUSTED CALLER ONLY — see the module header. Records an already-authenticated exit; never authenticates. */
export function* persistAuthenticatedExecutorExitSteps(driver: OwnershipDriver, record: { operationId: string; epoch: number; executorIdentity: string; attestedBy: string }): Generator<SQL, void, Rows> {
  exactPositiveInteger(record.epoch);
  yield sql`INSERT INTO photo_executor_exit_records (operation_id, executor_epoch, executor_identity, attested_by, exit_observed_ms)
    VALUES (${record.operationId}, ${record.epoch}, ${record.executorIdentity}, ${record.attestedBy}, ${nowMs(driver)}) RETURNING operation_id`;
}

/** Epoch n -> n+1 only with an exit record for the exact epoch-n executor identity; CAS on the epoch under the row lock. */
export function* transferPublicationAuthoritySteps(driver: OwnershipDriver, operationId: string, expectedEpoch: number, me: PublicationExecutor): Generator<SQL, AuthorityTransfer, Rows> {
  exactPositiveInteger(expectedEpoch + 1); // the next epoch must stay exact too
  yield lockOperationRow(driver, operationId);
  const [intent] = yield sql`SELECT ${INTENT_COLUMNS} FROM photo_publication_intents WHERE operation_id = ${operationId}${lockClause(driver)}`;
  if (!intent || intent.state !== "authorized") return { kind: "terminal" };
  if (!sameInteger(intent.executor_epoch, expectedEpoch)) return { kind: "lost" };
  const [record] = yield sql`SELECT operation_id FROM photo_executor_exit_records WHERE operation_id = ${operationId}
    AND executor_epoch = ${expectedEpoch} AND executor_identity = ${intent.executor_identity}`;
  if (!record) return { kind: "no-exit-record" };
  const [moved] = yield sql`UPDATE photo_publication_intents SET executor_epoch = ${expectedEpoch + 1}, executor_token = ${me.token},
    executor_identity = ${me.executorIdentity}, updated_ms = ${nowMs(driver)}
    WHERE operation_id = ${operationId} AND executor_epoch = ${expectedEpoch} AND state = 'authorized' RETURNING ${INTENT_COLUMNS}`;
  return moved ? { kind: "own", authority: toAuthority(moved) } : { kind: "lost" };
}

/** Moves the operation (existing reviewSteps) and the CURRENT executor's intent to review in one transaction. */
export function* reviewPublicationIntentSteps(driver: OwnershipDriver, a: PublicationAuthority, reason: string): Generator<SQL, void, Rows> {
  const op: OwnedOperation = { id: a.operationId, generation: a.generation, owner: a.owner, nonce: a.nonce, photoId: "", mainKey: a.mainKey, thumbKey: a.thumbKey };
  yield lockOperationRow(driver, a.operationId);
  yield* reviewSteps(driver, op, reason);
  yield sql`UPDATE photo_publication_intents SET state = 'review', updated_ms = ${nowMs(driver)}
    WHERE operation_id = ${a.operationId} AND state = 'authorized' AND executor_epoch = ${a.epoch} AND executor_token = ${a.token} RETURNING operation_id`;
}

export interface IntentCommitProof { authority: PublicationAuthority; photoId: string; eventId: string }

/**
 * Intent-authorized commit fence, used in the caller's photo + outbox transaction exactly like
 * commitDrizzlePhotoOperationFenced (which stays unchanged). Real predicates minus the lease, plus the full authority
 * tuple; also commits the generation history and the intent. Each must affect exactly one row.
 */
export function commitIntentAuthorizedPhotoOperation(tx: any, execution: "synchronous" | "asynchronous", p: IntentCommitProof): void | Promise<void> {
  const a = p.authority;
  if (!a || ![a.operationId, a.owner, a.nonce, a.sealId, a.token, a.executorIdentity, p.photoId, p.eventId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256)
      || !Number.isSafeInteger(a.generation) || a.generation < 1 || !Number.isSafeInteger(a.epoch) || a.epoch < 1) throw new Error("PHOTO_COMMIT_PROOF_INVALID");
  const now = nowMs(execution === "synchronous" ? "sqlite" : "postgres");
  const statements = [
    sql`UPDATE photo_operations SET state = 'committed', committed_photo_id = ${p.photoId}, committed_event_id = ${p.eventId}, updated_ms = ${now}
      WHERE id = ${a.operationId} AND generation = ${a.generation} AND owner = ${a.owner} AND nonce = ${a.nonce}
        AND state = 'sealed' AND seal_id = ${a.sealId} AND target_photo_id = ${p.photoId}
        AND EXISTS (SELECT 1 FROM photo_publication_intents i WHERE i.operation_id = photo_operations.id AND i.generation = ${a.generation}
          AND i.owner = ${a.owner} AND i.nonce = ${a.nonce} AND i.seal_id = ${a.sealId} AND i.state = 'authorized'
          AND i.executor_epoch = ${a.epoch} AND i.executor_token = ${a.token} AND i.executor_identity = ${a.executorIdentity})
      RETURNING id`,
    sql`UPDATE photo_operation_generations SET state = 'committed', updated_ms = ${now}
      WHERE operation_id = ${a.operationId} AND generation = ${a.generation} AND owner = ${a.owner} AND nonce = ${a.nonce} AND state = 'active' RETURNING operation_id`,
    sql`UPDATE photo_publication_intents SET state = 'committed', updated_ms = ${now}
      WHERE operation_id = ${a.operationId} AND state = 'authorized' AND executor_epoch = ${a.epoch} AND executor_token = ${a.token}
        AND executor_identity = ${a.executorIdentity} RETURNING operation_id`,
  ];
  const verify = (rows: unknown[]) => { if (rows.length !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST"); };
  if (execution === "synchronous") { for (const s of statements) verify(tx.all(s)); return; }
  return (async () => { for (const s of statements) verify(((await tx.execute(s)) as { rows: unknown[] }).rows); })();
}
