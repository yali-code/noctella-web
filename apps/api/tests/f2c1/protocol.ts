/**
 * #472 F2 Contract 1 test orchestration (test-only; never imported by runtime code).
 *
 * Since WP1 every protocol DECISION is the runtime module `src/services/photoPublicationIntents.ts` (T1, guarded
 * reclaim, exit-record persistence, transfer, review and the intent-authorized commit fence) on the runtime tables
 * from migration 0043 / schema.sql. This file keeps only orchestration the runtime does not have yet (that is the
 * later owner wiring): the W2 claim mirror, the authorized-link resume procedure and the composed W2 T2 with an
 * injected fence. The production lease fence (commitDrizzlePhotoOperationFenced) is never modified.
 * Proves protocol ordering for cooperative actors only: NOT capability enforcement, NOT byte immutability.
 */
import { link, lstat } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import {
  createOperation, inOwnershipTransaction, nowMs, photoOperationPrivateRoot,
  type OperationClaim, type OwnershipDriver, type Rows,
} from "../../src/services/photoOperationAuthority";
import {
  commitIntentAuthorizedPhotoOperation, guardedReclaimSteps, reviewPublicationIntentSteps,
  type PublicationAuthority, type PublicationExecutor,
} from "../../src/services/photoPublicationIntents";
import { ownedPhotoArtifactProof } from "../../src/services/ownedPhotoArtifactProof";
import { lockProductRowInTransaction } from "../../src/services/productPhotoMutationLockTransactionCapabilityForDb";
import { createProductPhotoWithPromotionOutboxInTransaction, listProductPhotosInTransaction } from "../../src/repositories/product-write/drizzle";
import { productPhotoStaticPath } from "../../src/services/photoStorage";
import { OutboxEventStatus, OutboxEventType } from "../../src/services/outbox";
import * as sqliteSchema from "../../src/db/schema.sqlite";
import * as postgresSchema from "../../src/db/schema.postgres";

export type F2c1Driver = OwnershipDriver;
export type Authority = PublicationAuthority;
export type ExecutorIdentity = PublicationExecutor;

const lockClause = (driver: F2c1Driver) => sql.raw(driver === "postgres" ? " FOR UPDATE" : "");

/** Mirrors W2 claimSteps; an existing operation goes through the runtime guarded reclaim. */
export function* guardedClaimSteps(driver: F2c1Driver, intent: { token: string; productId: string; sha256: string; actorId: string; altText: string }, ttl: number): Generator<SQL, OperationClaim | { kind: "conflict" }, Rows> {
  const now = nowMs(driver);
  const [stored] = yield sql`SELECT token, actor_id, product_id, input_sha256, alt_text, operation_id FROM photo_w2_upload_intents WHERE token = ${intent.token}${lockClause(driver)}`;
  if (stored) {
    if (stored.actor_id !== intent.actorId || stored.product_id !== intent.productId || stored.input_sha256 !== intent.sha256 || stored.alt_text !== intent.altText || !stored.operation_id)
      return { kind: "conflict" };
    return yield* guardedReclaimSteps(driver, stored.operation_id, ttl);
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

export function privateArtifactPath(canonicalRoot: string, a: Authority, artifact: "main" | "thumb") {
  return path.join(photoOperationPrivateRoot(canonicalRoot), a.operationId, String(a.generation), artifact + ".webp");
}

const same = (p: { sha256: string; dev: string; ino: string }, q: { sha256: string; dev: string; ino: string }) =>
  p.sha256 === q.sha256 && String(p.dev) === String(q.dev) && String(p.ino) === String(q.ino);

/** Runtime review of the operation and the current executor's intent. */
export async function markReview(db: any, driver: F2c1Driver, a: Authority, reason: string) {
  await inOwnershipTransaction(db, driver, () => reviewPublicationIntentSteps(driver, a, reason));
}

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

export interface T2Input { authority: Authority; productId: string; photoId: string; eventId: string; sizeBytes: number; width: number; height: number }
export type T2Fence = (tx: any, execution: "synchronous" | "asynchronous") => void | Promise<void>;

/** Adapter only: the runtime intent-authorized commit fence for one T2 input. */
export const intentFence = (input: T2Input): T2Fence => (tx, execution) =>
  commitIntentAuthorizedPhotoOperation(tx, execution, { authority: input.authority, photoId: input.photoId, eventId: input.eventId });

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
