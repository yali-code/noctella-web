/**
 * #472 F2 Contract 1 OFFLINE PROOF ONLY (test-only; never imported by runtime code).
 *
 * Cooperative-worker protocol around the REAL photo authority:
 * - T1 and guarded reclaim both take the photo_operations row lock (PostgreSQL FOR UPDATE, SQLite
 *   BEGIN IMMEDIATE) BEFORE reading f2c1_publication_intents. That shared boundary orders them.
 * - Guarded reclaim delegates to the unchanged real claimExistingOperation.
 * - Executor authority = (operation, generation, owner, nonce, seal, epoch, token, actor id). Epoch 1 is
 *   granted by T1 to exactly one token; epoch n+1 only by Transfer after a trusted-parent exit receipt.
 * - The intent-authorized T2 fence is TEST-ONLY. It replaces only the lease predicate and binds the full
 *   authority tuple. The production fence (commitDrizzlePhotoOperationFenced) is never modified.
 * Proves protocol ordering for cooperative actors only: NOT capability enforcement, NOT byte immutability.
 */
import { link, lstat } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import {
  claimExistingOperation, createOperation, nowMs, reviewSteps, photoOperationPrivateRoot,
  type OwnedOperation, type OperationClaim, type Rows,
} from "../../src/services/photoOperationAuthority";
import { ownedPhotoArtifactProof } from "../../src/services/ownedPhotoArtifactProof";
import { lockProductRowInTransaction } from "../../src/services/productPhotoMutationLockTransactionCapabilityForDb";
import { createProductPhotoWithPromotionOutboxInTransaction, listProductPhotosInTransaction } from "../../src/repositories/product-write/drizzle";
import { productPhotoStaticPath } from "../../src/services/photoStorage";
import { OutboxEventStatus, OutboxEventType } from "../../src/services/outbox";
import * as sqliteSchema from "../../src/db/schema.sqlite";
import * as postgresSchema from "../../src/db/schema.postgres";
import type { F2c1Driver } from "./intentSchema";

export interface ExecutorIdentity { token: string; actorId: string }
export interface Authority {
  operationId: string; generation: number; owner: string; nonce: string; sealId: string;
  epoch: number; token: string; actorId: string; mainKey: string; thumbKey: string;
  identity: { main: { sha256: string; dev: string; ino: string }; thumb: { sha256: string; dev: string; ino: string } };
}
export type T1Result =
  | { kind: "own"; authority: Authority }
  | { kind: "held-by-other" }
  | { kind: "rejected"; reason: string }
  | { kind: "terminal"; state: string };
export type TransferResult = { kind: "own"; authority: Authority } | { kind: "no-receipt" | "lost" | "terminal" };

/** Marker for statements that return no rows (SAVEPOINT etc.). */
type Step = SQL | { run: SQL };
const runOnly = (statement: SQL): Step => ({ run: statement });

function errorCode(error: unknown): string | undefined {
  for (let e: any = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/.test(String(e.message ?? "") + String(e.code ?? ""))) return "23505";
  }
  return undefined;
}
export const isUniqueViolation = (error: unknown) => errorCode(error) === "23505";
/** Any statement attempted inside an aborted PostgreSQL transaction is a protocol defect. */
export const isAbortedTransaction = (error: unknown) => errorCode(error) === "25P02";

/**
 * Runs generator-expressed steps in ONE transaction. Unlike inOwnershipTransaction, statement errors are
 * thrown INTO the generator so it can roll back to a savepoint. SQLite: BEGIN IMMEDIATE (synchronous).
 */
export function inF2c1Transaction<T>(db: any, driver: F2c1Driver, steps: () => Generator<Step, T, Rows>): T | Promise<T> {
  if (driver === "sqlite") {
    let result!: T;
    db.transaction((tx: any) => {
      const gen = steps();
      let step = gen.next();
      while (!step.done) {
        let rows: Rows | undefined, failure: unknown, failed = false;
        try { rows = "run" in step.value ? (tx.run(step.value.run), []) : tx.all(step.value); } catch (e) { failure = e; failed = true; }
        step = failed ? gen.throw(failure) : gen.next(rows!);
      }
      result = step.value;
    }, { behavior: "immediate" });
    return result;
  }
  return db.transaction(async (tx: any) => {
    const gen = steps();
    let step = gen.next();
    while (!step.done) {
      let rows: Rows | undefined, failure: unknown, failed = false;
      try { rows = ((await tx.execute("run" in step.value ? step.value.run : step.value)) as { rows: Rows }).rows; } catch (e) { failure = e; failed = true; }
      step = failed ? gen.throw(failure) : gen.next(rows!);
    }
    return step.value;
  });
}

const lockClause = (driver: F2c1Driver) => sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
const lockOperationRow = (driver: F2c1Driver, operationId: string) =>
  sql`SELECT id FROM photo_operations WHERE id = ${operationId}${lockClause(driver)}`;

function toAuthority(row: Record<string, any>): Authority {
  return {
    operationId: row.operation_id, generation: Number(row.generation), owner: row.owner, nonce: row.nonce, sealId: row.seal_id,
    epoch: Number(row.executor_epoch), token: row.executor_token, actorId: row.executor_actor_id, mainKey: row.main_key, thumbKey: row.thumb_key,
    identity: {
      main: { sha256: row.main_sha256, dev: String(row.main_dev), ino: String(row.main_ino) },
      thumb: { sha256: row.thumb_sha256, dev: String(row.thumb_dev), ino: String(row.thumb_ino) },
    },
  };
}

function classifyExisting(row: Record<string, any>, op: OwnedOperation, sealId: string, me: ExecutorIdentity): T1Result {
  if (row.state !== "authorized") return { kind: "terminal", state: row.state };
  if (Number(row.generation) !== op.generation || row.owner !== op.owner || row.nonce !== op.nonce || row.seal_id !== sealId)
    return { kind: "rejected", reason: "intent bound to another generation or seal" };
  // A lost-acknowledgement retry is the SAME caller: same token AND same trusted actor identity.
  if (row.executor_token === me.token && row.executor_actor_id === me.actorId) return { kind: "own", authority: toAuthority(row) };
  return { kind: "held-by-other" };
}

/** Mirrors W2 claimSteps; the reclaim decision itself is the unchanged real claimExistingOperation. */
export function* guardedClaimSteps(driver: F2c1Driver, intent: { token: string; productId: string; sha256: string; actorId: string; altText: string }, ttl: number): Generator<Step, OperationClaim | { kind: "conflict" }, Rows> {
  const now = nowMs(driver);
  const [stored] = yield sql`SELECT token, actor_id, product_id, input_sha256, alt_text, operation_id FROM photo_w2_upload_intents WHERE token = ${intent.token}${lockClause(driver)}`;
  if (stored) {
    if (stored.actor_id !== intent.actorId || stored.product_id !== intent.productId || stored.input_sha256 !== intent.sha256 || stored.alt_text !== intent.altText || !stored.operation_id)
      return { kind: "conflict" };
    yield lockOperationRow(driver, stored.operation_id);
    const [publication] = yield sql`SELECT state FROM f2c1_publication_intents WHERE operation_id = ${stored.operation_id}`;
    if (publication?.state === "authorized") return { kind: "in-progress" }; // Contract 1: never reclaim publishing
    return yield* claimExistingOperation(driver, stored.operation_id, ttl);
  }
  const photoId = crypto.randomUUID();
  const op = yield* createOperation(driver, {
    kind: "product_upload", subjectType: "w2_request", subjectId: intent.token, targetPhotoId: photoId,
    mainKey: `${intent.productId}-${photoId}.webp`, thumbKey: `${intent.productId}-${photoId}-thumb.webp`, inputSha256: intent.sha256,
  }, ttl);
  yield sql`INSERT INTO photo_w2_upload_intents (token, tenant_id, actor_id, product_id, input_sha256, alt_text, operation_id, created_ms)
    VALUES (${intent.token}, 'noctella', ${intent.actorId}, ${intent.productId}, ${intent.sha256}, ${intent.altText}, ${op.id}, ${now}) RETURNING token`;
  return { kind: "owned", op };
}

/** T1: durable publication authorization. Admission still requires a live DB-clock lease. */
export function* t1Steps(driver: F2c1Driver, op: OwnedOperation, sealId: string, me: ExecutorIdentity): Generator<Step, T1Result, Rows> {
  const now = nowMs(driver);
  yield lockOperationRow(driver, op.id);
  const [existing] = yield sql`SELECT * FROM f2c1_publication_intents WHERE operation_id = ${op.id}`;
  if (existing) return classifyExisting(existing, op, sealId, me);
  const [current] = yield sql`SELECT id FROM photo_operations WHERE id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner}
    AND nonce = ${op.nonce} AND state = 'sealed' AND seal_id = ${sealId} AND lease_until_ms > ${now}`;
  if (!current) return { kind: "rejected", reason: "not the current sealed generation with a live lease" };
  const [seal] = yield sql`SELECT main_sha256, main_dev, main_ino, thumb_sha256, thumb_dev, thumb_ino FROM photo_operation_artifacts
    WHERE id = ${sealId} AND operation_id = ${op.id} AND generation = ${op.generation}`;
  if (!seal) return { kind: "rejected", reason: "seal not found" };
  yield runOnly(sql`SAVEPOINT f2c1_t1`);
  try {
    const [row] = yield sql`INSERT INTO f2c1_publication_intents (operation_id, generation, owner, nonce, seal_id, main_key, thumb_key,
      main_sha256, main_dev, main_ino, thumb_sha256, thumb_dev, thumb_ino, executor_epoch, executor_token, executor_actor_id, state, created_ms, updated_ms)
      VALUES (${op.id}, ${op.generation}, ${op.owner}, ${op.nonce}, ${sealId}, ${op.mainKey}, ${op.thumbKey},
      ${seal.main_sha256}, ${String(seal.main_dev)}, ${String(seal.main_ino)}, ${seal.thumb_sha256}, ${String(seal.thumb_dev)}, ${String(seal.thumb_ino)},
      1, ${me.token}, ${me.actorId}, 'authorized', ${now}, ${now}) RETURNING *`;
    yield runOnly(sql`RELEASE SAVEPOINT f2c1_t1`);
    return { kind: "own", authority: toAuthority(row) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The transaction is usable again only after rolling back to the savepoint; never query before this.
    yield runOnly(sql`ROLLBACK TO SAVEPOINT f2c1_t1`);
    const [winner] = yield sql`SELECT * FROM f2c1_publication_intents WHERE operation_id = ${op.id}`;
    return winner ? classifyExisting(winner, op, sealId, me) : { kind: "rejected", reason: "unique violation without an intent for this operation" };
  }
}

/** Trusted parent only: records that it observed the exact executor process of `epoch` exit. */
export function* recordExitReceiptSteps(driver: F2c1Driver, operationId: string, epoch: number, observedBy: string, processHandle: string): Generator<Step, void, Rows> {
  yield sql`INSERT INTO f2c1_executor_exit_receipts (operation_id, executor_epoch, observed_by, process_handle, exit_observed_ms)
    VALUES (${operationId}, ${epoch}, ${observedBy}, ${processHandle}, ${nowMs(driver)}) RETURNING operation_id`;
}

/** Epoch n -> n+1 only with a receipt for the exact epoch-n executor; CAS on the epoch under the row lock. */
export function* transferSteps(driver: F2c1Driver, operationId: string, expectedEpoch: number, me: ExecutorIdentity): Generator<Step, TransferResult, Rows> {
  yield lockOperationRow(driver, operationId);
  const [intent] = yield sql`SELECT * FROM f2c1_publication_intents WHERE operation_id = ${operationId}${lockClause(driver)}`;
  if (!intent || intent.state !== "authorized") return { kind: "terminal" };
  if (Number(intent.executor_epoch) !== expectedEpoch) return { kind: "lost" };
  const [receipt] = yield sql`SELECT operation_id FROM f2c1_executor_exit_receipts WHERE operation_id = ${operationId}
    AND executor_epoch = ${expectedEpoch} AND process_handle = ${intent.executor_actor_id}`;
  if (!receipt) return { kind: "no-receipt" };
  const [moved] = yield sql`UPDATE f2c1_publication_intents SET executor_epoch = ${expectedEpoch + 1}, executor_token = ${me.token},
    executor_actor_id = ${me.actorId}, updated_ms = ${nowMs(driver)}
    WHERE operation_id = ${operationId} AND executor_epoch = ${expectedEpoch} AND state = 'authorized' RETURNING *`;
  return moved ? { kind: "own", authority: toAuthority(moved) } : { kind: "lost" };
}

const asOperation = (a: Authority, photoId = ""): OwnedOperation =>
  ({ id: a.operationId, generation: a.generation, owner: a.owner, nonce: a.nonce, photoId, mainKey: a.mainKey, thumbKey: a.thumbKey });

export function privateArtifactPath(canonicalRoot: string, a: Authority, artifact: "main" | "thumb") {
  return path.join(photoOperationPrivateRoot(canonicalRoot), a.operationId, String(a.generation), artifact + ".webp");
}

const same = (p: { sha256: string; dev: string; ino: string }, q: { sha256: string; dev: string; ino: string }) =>
  p.sha256 === q.sha256 && String(p.dev) === String(q.dev) && String(p.ino) === String(q.ino);

/**
 * Resume procedure, executed only by the CURRENT executor. Performs authorized missing links; keeps a
 * canonical name already holding the intent's exact inode; anything else is review. Never overwrites or deletes.
 */
export async function executeAuthorizedLinks(db: any, driver: F2c1Driver, a: Authority, canonicalRoot: string): Promise<"linked" | "review"> {
  for (const artifact of ["main", "thumb"] as const) {
    const canonical = path.join(canonicalRoot, artifact === "main" ? a.mainKey : a.thumbKey);
    const expected = a.identity[artifact];
    let present = true;
    try { await lstat(canonical); } catch (error: any) { if (error?.code !== "ENOENT") throw error; present = false; }
    if (present) {
      if (same(await ownedPhotoArtifactProof(canonical), expected)) continue;
      await markReview(db, driver, a, "canonical name holds a different inode");
      return "review";
    }
    const source = privateArtifactPath(canonicalRoot, a, artifact);
    let proof;
    try { proof = await ownedPhotoArtifactProof(source); } catch { await markReview(db, driver, a, "private sealed artifact missing"); return "review"; }
    if (!same(proof, expected)) { await markReview(db, driver, a, "private sealed artifact changed"); return "review"; }
    try { await link(source, canonical); }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (!same(await ownedPhotoArtifactProof(canonical), expected)) { await markReview(db, driver, a, "concurrent foreign canonical name"); return "review"; }
    }
    if (!same(await ownedPhotoArtifactProof(canonical), expected)) { await markReview(db, driver, a, "published inode differs from intent"); return "review"; }
  }
  return "linked";
}

async function markReview(db: any, driver: F2c1Driver, a: Authority, reason: string) {
  await inF2c1Transaction(db, driver, function* () {
    yield lockOperationRow(driver, a.operationId);
    yield* reviewSteps(driver, asOperation(a), reason);
    yield sql`UPDATE f2c1_publication_intents SET state = 'review', updated_ms = ${nowMs(driver)}
      WHERE operation_id = ${a.operationId} AND state = 'authorized' AND executor_epoch = ${a.epoch} AND executor_token = ${a.token} RETURNING operation_id`;
  });
}

export interface T2Input { authority: Authority; productId: string; photoId: string; eventId: string; sizeBytes: number; width: number; height: number }
export type T2Fence = (tx: any, execution: "synchronous" | "asynchronous") => void | Promise<void>;

/** TEST-ONLY intent-authorized fence: the real predicates minus the lease, plus the full authority tuple. */
export function intentAuthorizedFence(driver: F2c1Driver, input: T2Input): T2Fence {
  const a = input.authority, now = nowMs(driver);
  const operation = sql`UPDATE photo_operations SET state = 'committed', committed_photo_id = ${input.photoId}, committed_event_id = ${input.eventId}, updated_ms = ${now}
    WHERE id = ${a.operationId} AND generation = ${a.generation} AND owner = ${a.owner} AND nonce = ${a.nonce}
      AND state = 'sealed' AND seal_id = ${a.sealId} AND target_photo_id = ${input.photoId}
      AND EXISTS (SELECT 1 FROM f2c1_publication_intents i WHERE i.operation_id = photo_operations.id AND i.generation = ${a.generation}
        AND i.owner = ${a.owner} AND i.nonce = ${a.nonce} AND i.seal_id = ${a.sealId} AND i.state = 'authorized'
        AND i.executor_epoch = ${a.epoch} AND i.executor_token = ${a.token} AND i.executor_actor_id = ${a.actorId})
    RETURNING id`;
  const history = sql`UPDATE photo_operation_generations SET state = 'committed', updated_ms = ${now}
    WHERE operation_id = ${a.operationId} AND generation = ${a.generation} AND owner = ${a.owner} AND nonce = ${a.nonce} AND state = 'active' RETURNING operation_id`;
  const intent = sql`UPDATE f2c1_publication_intents SET state = 'committed', updated_ms = ${now}
    WHERE operation_id = ${a.operationId} AND state = 'authorized' AND executor_epoch = ${a.epoch} AND executor_token = ${a.token}
      AND executor_actor_id = ${a.actorId} RETURNING operation_id`;
  const check = (rows: unknown[]) => { if (rows.length !== 1) throw new Error("PHOTO_OPERATION_FENCE_LOST"); };
  return (tx, execution) => {
    if (execution === "synchronous") { for (const statement of [operation, history, intent]) check(tx.all(statement)); return; }
    return (async () => { for (const statement of [operation, history, intent]) check(((await tx.execute(statement)) as { rows: unknown[] }).rows); })();
  };
}

/**
 * Harness T2 composed ONLY from the exported pieces the real persist path uses (product lock, list, photo+outbox
 * writer), with an injected fence. Row values mirror products.ts persistUploadedProductPhoto (parity case P1).
 * SQLite uses BEGIN IMMEDIATE (runtime uses the drizzle default) for cross-process determinism only.
 */
export function harnessT2(db: any, driver: F2c1Driver, input: Omit<T2Input, "authority"> & { mainKey: string; thumbKey: string }, fence: T2Fence): unknown {
  const schema = driver === "sqlite" ? sqliteSchema : postgresSchema;
  const execution = driver === "sqlite" ? "synchronous" as const : "asynchronous" as const;
  const now = new Date().toISOString();
  const url = `${productPhotoStaticPath}/${input.mainKey}`, thumbnailUrl = `${productPhotoStaticPath}/${input.thumbKey}`;
  const build = (existing: any[]) => ({
    values: {
      id: input.photoId, productId: input.productId, url, thumbnailUrl, altText: null, sortOrder: existing.length, isPrimary: existing.length === 0,
      filename: input.mainKey, mimeType: "image/webp", sizeBytes: input.sizeBytes, width: input.width, height: input.height,
      processingStatus: "Processing", storageKey: path.basename(url), thumbnailStorageKey: path.basename(thumbnailUrl),
      processingUpdatedAt: now, createdAt: now, updatedAt: now,
    },
    outboxEvent: {
      id: input.eventId, eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", aggregateId: input.photoId,
      idempotencyKey: `product-photo-promote:${input.photoId}`, payload: JSON.stringify({ photoId: input.photoId, productId: input.productId }),
      status: OutboxEventStatus.Pending, attemptCount: 0, maxAttempts: 3, availableAt: now, createdAt: now, updatedAt: now,
    },
  });
  if (driver === "sqlite") {
    return db.transaction((tx: any) => {
      lockProductRowInTransaction(tx, schema, execution, input.productId);
      const existing = listProductPhotosInTransaction(tx, schema, execution, input.productId) as any[];
      createProductPhotoWithPromotionOutboxInTransaction(tx, schema, execution, build(existing));
      fence(tx, execution);
    }, { behavior: "immediate" });
  }
  return db.transaction(async (tx: any) => {
    await lockProductRowInTransaction(tx, schema, execution, input.productId);
    const existing = (await listProductPhotosInTransaction(tx, schema, execution, input.productId)) as any[];
    await createProductPhotoWithPromotionOutboxInTransaction(tx, schema, execution, build(existing));
    await fence(tx, execution);
  });
}
