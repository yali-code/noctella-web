/**
 * #472 F2 Step 4 OFFLINE COMPOSITION (test-only; never imported by runtime code).
 *
 * Composes, around the REAL photo-operation authority and REAL W2/W4 preparation/T2 building blocks:
 *  - Contract 1 durable intent, guarded reclaim and T1/T2 (`../f2c1/protocol`),
 *  - Step 2 confined workers and authenticated supervisor completion (the test launcher),
 *  - Step 3 publisher-owned verified copies (`../f2s3/snapshotPublisher`).
 *
 * MISSING RUNTIME SEAM (BLOCKED, not hidden): the real owners `uploadFencedProductPhoto` (W2) and
 * `buildFencedAiIntakePhotoFinalizationManifest` (W4) call `publishSealedArtifacts`, which links the worker-owned
 * private inode, and their commits call the lease-fenced `commitDrizzlePhotoOperationFenced`. Neither accepts an
 * injected publisher, intent or fence. This module therefore composes the owners' exported building blocks; it does
 * NOT prove that the production owners are integrated.
 */
import { sql } from "drizzle-orm";
import path from "node:path";
import {
  claimExistingOperation, createOperation, findOperationBySubject, nowMs, reviewSteps,
  type OperationClaim, type OwnedOperation, type Rows,
} from "../../src/services/photoOperationAuthority";
import { lockProductRowInTransaction } from "../../src/services/productPhotoMutationLockTransactionCapabilityForDb";
import { createProductPhotoWithPromotionOutboxInTransaction } from "../../src/repositories/product-write/drizzle";
import { finalizeIntakeWithExpectedStateInTransaction } from "../../src/repositories/ai-product-intake/drizzle";
import { OutboxEventStatus, OutboxEventType } from "../../src/services/outbox";
import { productPhotoStaticPath } from "../../src/services/photoStorage";
import * as sqliteSchema from "../../src/db/schema.sqlite";
import * as postgresSchema from "../../src/db/schema.postgres";
import { inF2c1Transaction, intentAuthorizedFence, privateArtifactPath, type Authority } from "../f2c1/protocol";
import type { F2c1Driver } from "../f2c1/intentSchema";
import { publish, type Outcome, type Phase, type PublishTarget } from "../f2s3/snapshotPublisher";

type Step = ReturnType<typeof sql>;
const lockClause = (driver: F2c1Driver) => sql.raw(driver === "postgres" ? " FOR UPDATE" : "");

/** Mirrors the real W4 claimSteps; the reclaim decision is the unchanged real claimExistingOperation. */
export function* guardedClaimW4Steps(driver: F2c1Driver, productId: string, stagedPhotoId: string, inputSha256: string, ttl: number): Generator<Step, OperationClaim | { kind: "conflict" }, Rows> {
  const mainKey = `${productId}-${stagedPhotoId}.webp`, thumbKey = `${productId}-${stagedPhotoId}-thumb.webp`;
  const existing = yield* findOperationBySubject(driver, "ai_intake_photo", stagedPhotoId);
  if (existing) {
    if (existing.kind !== "ai_finalize" || existing.target_photo_id !== stagedPhotoId || existing.main_key !== mainKey || existing.thumb_key !== thumbKey || existing.input_sha256 !== inputSha256)
      return { kind: "conflict" };
    yield sql`SELECT id FROM photo_operations WHERE id = ${existing.id}${lockClause(driver)}`;
    const [publication] = yield sql`SELECT state FROM f2c1_publication_intents WHERE operation_id = ${existing.id}`;
    if (publication?.state === "authorized") return { kind: "in-progress" }; // Contract 1: never reclaim publishing
    return yield* claimExistingOperation(driver, existing.id, ttl);
  }
  const op = yield* createOperation(driver, { kind: "ai_finalize", subjectType: "ai_intake_photo", subjectId: stagedPhotoId, targetPhotoId: stagedPhotoId, mainKey, thumbKey, inputSha256 }, ttl);
  return { kind: "owned", op };
}

/** Operation-private staging namespace per artifact: same filesystem as the canonical root (link() requirement). */
export const stagingTarget = (a: Authority, artifact: "main" | "thumb", size: number, canonicalDir: string, stagingRoot: string): PublishTarget => ({
  source: privateArtifactPath(canonicalDir, a, artifact),
  seal: { sha256: a.identity[artifact].sha256, size, dev: a.identity[artifact].dev, ino: a.identity[artifact].ino },
  canonicalDir, canonicalName: artifact === "main" ? a.mainKey : a.thumbKey,
  stagingRoot, operationId: `${a.operationId}-${artifact}`, generation: a.generation,
});

async function markReview(db: any, driver: F2c1Driver, a: Authority, reason: string) {
  const op: OwnedOperation = { id: a.operationId, generation: a.generation, owner: a.owner, nonce: a.nonce, photoId: "", mainKey: a.mainKey, thumbKey: a.thumbKey };
  await inF2c1Transaction(db, driver, function* () {
    yield sql`SELECT id FROM photo_operations WHERE id = ${a.operationId}${lockClause(driver)}`;
    yield* reviewSteps(driver, op, reason);
    yield sql`UPDATE f2c1_publication_intents SET state = 'review', updated_ms = ${nowMs(driver)}
      WHERE operation_id = ${a.operationId} AND state = 'authorized' AND executor_epoch = ${a.epoch} AND executor_token = ${a.token} RETURNING operation_id`;
  });
}

/**
 * Copy-owned publication of ONE authorized operation (main, then thumb). Called only by the current intent executor.
 * Any outcome other than PUBLISHED/ADOPTED moves the operation and its intent to review; nothing is overwritten.
 */
export async function publishAuthorized(db: any, driver: F2c1Driver, a: Authority, canonicalDir: string, stagingRoot: string,
  hook: (artifact: "main" | "thumb", phase: Phase) => void | Promise<void> = () => {}): Promise<{ status: "published" | "review"; outcomes: Record<string, Outcome> }> {
  const [sizes]: any = await inF2c1Transaction(db, driver, function* (): Generator<any, Rows, Rows> {
    return yield sql`SELECT main_bytes, thumb_bytes FROM photo_operation_artifacts WHERE id = ${a.sealId} AND operation_id = ${a.operationId} AND generation = ${a.generation}`;
  });
  const outcomes: Record<string, Outcome> = {};
  for (const artifact of ["main", "thumb"] as const) {
    const outcome = await publish(stagingTarget(a, artifact, Number(sizes[artifact + "_bytes"]), canonicalDir, stagingRoot), (phase) => hook(artifact, phase));
    outcomes[artifact] = outcome;
    if (outcome.kind !== "PUBLISHED" && outcome.kind !== "ADOPTED") {
      await markReview(db, driver, a, `copy-owned publication ${artifact}: ${outcome.kind}`);
      return { status: "review", outcomes };
    }
  }
  return { status: "published", outcomes };
}

export interface W4Entry { authority: Authority; stagedPhotoId: string; sortOrder: number; isPrimary: boolean; sizeBytes: number; width: number; height: number; eventId: string }

/**
 * Composed W4 T2: ONE transaction — intake lock, product lock, per entry photo + promote outbox + test-only
 * intent-authorized fence, then the real guarded intake finalization. Row values mirror the real W4 use case.
 */
export function harnessT2W4(db: any, driver: F2c1Driver, input: { intakeId: string; productId: string; actorId: string; entries: W4Entry[] }): unknown {
  const schema = driver === "sqlite" ? sqliteSchema : postgresSchema;
  const execution = driver === "sqlite" ? "synchronous" as const : "asynchronous" as const;
  const now = new Date().toISOString();
  const photo = (e: W4Entry) => {
    const main = e.authority.mainKey, thumb = e.authority.thumbKey;
    return {
      values: {
        id: e.stagedPhotoId, productId: input.productId, url: `${productPhotoStaticPath}/${main}`, thumbnailUrl: `${productPhotoStaticPath}/${thumb}`,
        altText: null, sortOrder: e.sortOrder, isPrimary: e.isPrimary, filename: main, mimeType: "image/webp", sizeBytes: e.sizeBytes,
        width: e.width, height: e.height, processingStatus: "Processing", storageKey: main, thumbnailStorageKey: thumb,
        processingUpdatedAt: now, createdAt: now, updatedAt: now,
      },
      outboxEvent: {
        id: e.eventId, eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", aggregateId: e.stagedPhotoId,
        idempotencyKey: `product-photo-promote:${e.stagedPhotoId}`, payload: JSON.stringify({ photoId: e.stagedPhotoId, productId: input.productId }),
        status: OutboxEventStatus.Pending, attemptCount: 0, maxAttempts: 3, availableAt: now, createdAt: now, updatedAt: now,
      },
    };
  };
  const finalize = { id: input.intakeId, finalizedAt: now, finalizedByAdminUserId: input.actorId, updatedAt: now };
  const lockIntake = sql`SELECT id FROM ai_product_intakes WHERE id = ${input.intakeId}${lockClause(driver)}`;
  if (driver === "sqlite") {
    return db.transaction((tx: any) => {
      tx.all(lockIntake);
      lockProductRowInTransaction(tx, schema, execution, input.productId);
      for (const e of input.entries) {
        createProductPhotoWithPromotionOutboxInTransaction(tx, schema, execution, photo(e));
        intentAuthorizedFence(driver, { authority: e.authority, productId: input.productId, photoId: e.stagedPhotoId, eventId: e.eventId, sizeBytes: e.sizeBytes, width: e.width, height: e.height })(tx, execution);
      }
      const result: any = finalizeIntakeWithExpectedStateInTransaction(tx, schema, execution, finalize);
      if (!result.updated) throw new Error("INTAKE_NOT_APPLIED");
    }, { behavior: "immediate" });
  }
  return db.transaction(async (tx: any) => {
    await tx.execute(lockIntake);
    await lockProductRowInTransaction(tx, schema, execution, input.productId);
    for (const e of input.entries) {
      await createProductPhotoWithPromotionOutboxInTransaction(tx, schema, execution, photo(e));
      await intentAuthorizedFence(driver, { authority: e.authority, productId: input.productId, photoId: e.stagedPhotoId, eventId: e.eventId, sizeBytes: e.sizeBytes, width: e.width, height: e.height })(tx, execution);
    }
    const result: any = await finalizeIntakeWithExpectedStateInTransaction(tx, schema, execution, finalize);
    if (!result.updated) throw new Error("INTAKE_NOT_APPLIED");
  });
}

export const manifestOf = (stagingRoot: string, a: Authority, artifact: "main" | "thumb") =>
  path.join(stagingRoot, `${a.operationId}-${artifact}`, String(a.generation), "manifest.json");
