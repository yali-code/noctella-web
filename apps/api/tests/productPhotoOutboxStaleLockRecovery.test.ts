// Sprint 75: proves an outbox event left in Processing by an abrupt crash (a lock older than
// PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS) is automatically reclaimed and processed the next time the
// real scheduler endpoint (POST /api/background-jobs/run) runs, that a genuinely fresh Processing
// lock is left untouched, that no duplicate event row is ever created, that repeated scheduler
// execution stays idempotent, and that a stale event which fails on retry becomes RetryPending
// (not corrupted, not silently dropped) exactly like the dispatcher's existing failure handling.
// Real app, real LocalPhotoStorage, real in-memory SQLite - see productPhotoOutboxScheduler.test.ts
// for the established pattern this file follows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { ProductStatus, ProductType } from "@noctella/shared";

let photoDir: string;

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-stale-lock";

beforeAll(async () => {
  photoDir = await fs.mkdtemp(path.join(os.tmpdir(), "noctella-photo-stale-lock-"));
  process.env.PRODUCT_PHOTO_DIR = photoDir;
});

describe("stale Processing outbox event recovery via the scheduler endpoint (Sprint 75)", () => {
  it("reclaims and processes a stale-locked event, leaves a fresh lock untouched, stays duplicate-free and idempotent, and does not corrupt a stale event that then fails", async () => {
    const { default: app } = await import("../src/app");
    const { db } = await import("../src/db/client");
    const { uploadProductPhoto } = await import("../src/services/products");
    const { productPhotos, products, outboxEvents, outboxAttempts } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const { OutboxEventStatus } = await import("../src/services/outbox");
    const { PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS } = await import("../src/services/productPhotoOutboxDispatcher");

    async function makeProduct(id: string) {
      await db.insert(products).values({
        id,
        slug: id,
        sku: `SKU-${id}`,
        title: `Stale Lock Product ${id}`,
        type: ProductType.UniqueItem,
        status: ProductStatus.Published,
        customsWarning: false,
        isFeatured: false,
        allowMakeOffer: false,
        allowCashOnDelivery: false,
        showInArchiveAfterSale: false,
        priceEur: 100,
      });
    }

    async function uploadRealPhoto(productId: string) {
      const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).png().toBuffer();
      return uploadProductPhoto(db, productId, { buffer, mimetype: "image/png", size: buffer.length });
    }

    const staleLockedAt = new Date(Date.now() - PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS - 60_000).toISOString();
    const freshLockedAt = new Date(Date.now() - 1_000).toISOString();

    // --- Event 1: recoverable stale lock (files genuinely present on disk) ---
    await makeProduct("stale-recoverable-product");
    const recoverablePhoto = await uploadRealPhoto("stale-recoverable-product");
    await db
      .update(outboxEvents)
      .set({ status: OutboxEventStatus.Processing, lockedAt: staleLockedAt, lockedBy: "crashed-worker" })
      .where(eq(outboxEvents.aggregateId, recoverablePhoto.id));

    // --- Event 2: a genuinely fresh Processing lock, must never be released ---
    await makeProduct("fresh-lock-product");
    const freshPhoto = await uploadRealPhoto("fresh-lock-product");
    await db
      .update(outboxEvents)
      .set({ status: OutboxEventStatus.Processing, lockedAt: freshLockedAt, lockedBy: "still-running-worker" })
      .where(eq(outboxEvents.aggregateId, freshPhoto.id));

    // --- Event 3: stale lock, but its file is missing on disk - must fail without corruption.
    // Points the photo row's storageKey at a filename that was never written, rather than
    // deleting a real sharp-written file (sharp's native bindings can hold a Windows file handle
    // open for several seconds after toFile() resolves, which is irrelevant test-infra friction,
    // not part of the behavior under test). ---
    await makeProduct("stale-failing-product");
    const failingPhoto = await uploadRealPhoto("stale-failing-product");
    await db
      .update(productPhotos)
      .set({ storageKey: "never-written.webp", thumbnailStorageKey: "never-written-thumb.webp" })
      .where(eq(productPhotos.id, failingPhoto.id));
    await db
      .update(outboxEvents)
      .set({ status: OutboxEventStatus.Processing, lockedAt: staleLockedAt, lockedBy: "crashed-worker" })
      .where(eq(outboxEvents.aggregateId, failingPhoto.id));
    const [failingEventOriginal] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, failingPhoto.id));

    const eventCountBefore = (await db.select().from(outboxEvents)).length;
    expect(eventCountBefore).toBe(3);

    // ---- run the real authenticated scheduler flow once ----
    const firstRun = await request(app)
      .post("/api/background-jobs/run")
      .set("Authorization", "Bearer test-scheduler-token-stale-lock")
      .send({});
    expect(firstRun.status).toBe(200);

    // Event 1 was reclaimed and successfully processed.
    const [recoverableEvent] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, recoverablePhoto.id));
    expect(recoverableEvent.status).toBe(OutboxEventStatus.Succeeded);
    const [recoverableRow] = await db.select().from(productPhotos).where(eq(productPhotos.id, recoverablePhoto.id));
    expect(recoverableRow.processingStatus).toBe("Ready");

    // Event 2's fresh lock was left completely untouched - not released, not claimed.
    const [freshEvent] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, freshPhoto.id));
    expect(freshEvent.status).toBe(OutboxEventStatus.Processing);
    expect(freshEvent.lockedAt).toBe(freshLockedAt);
    expect(freshEvent.lockedBy).toBe("still-running-worker");

    // Event 3 was reclaimed, attempted, failed (missing files), and became RetryPending - not
    // corrupted, not deleted, not silently dropped, not dead-lettered on a single attempt. Event
    // identity, idempotency key, and payload are all preserved exactly as the dispatcher's
    // existing failure path already guarantees (proven behaviorally in outbox.test.ts).
    const [failingEvent] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, failingPhoto.id));
    expect(failingEvent.status).toBe(OutboxEventStatus.RetryPending);
    expect(failingEvent.id).toBe(failingEventOriginal.id);
    expect(failingEvent.idempotencyKey).toBe(failingEventOriginal.idempotencyKey);
    expect(failingEvent.payload).toBe(failingEventOriginal.payload);
    expect(failingEvent.aggregateId).toBe(failingPhoto.id);
    expect(failingEvent.lastErrorMessage).toBeTruthy();
    expect(failingEvent.lockedAt).toBeNull();
    expect(failingEvent.lockedBy).toBeNull();

    // The dispatcher's own audit trail (outbox_attempts) records this as a real, immutable
    // attempt row - the existing, unchanged failure-handling behavior already proven in
    // outbox.test.ts.
    const failingAttempts = await db.select().from(outboxAttempts).where(eq(outboxAttempts.outboxEventId, failingEvent.id));
    expect(failingAttempts).toHaveLength(1);
    expect(failingAttempts[0].result).toBe("Failed");

    const [failingPhotoRowAfter] = await db.select().from(productPhotos).where(eq(productPhotos.id, failingPhoto.id));
    expect(failingPhotoRowAfter.processingStatus).toBe("Processing");

    // No duplicate event rows were created by the reclaim-and-dispatch cycle.
    const eventCountAfterFirstRun = (await db.select().from(outboxEvents)).length;
    expect(eventCountAfterFirstRun).toBe(3);

    // ---- repeated scheduler execution stays safe and idempotent ----
    const secondRun = await request(app)
      .post("/api/background-jobs/run")
      .set("Authorization", "Bearer test-scheduler-token-stale-lock")
      .send({});
    expect(secondRun.status).toBe(200);
    // Event 1 must not be reprocessed (already Succeeded); Event 2 remains a fresh, untouched
    // lock; Event 3 is not yet due again (RetryPending with a future availableAt from backoff).
    expect(secondRun.body.photoOutboxProcessed).toBe(0);

    const [recoverableEventAfterSecondRun] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, recoverablePhoto.id));
    expect(recoverableEventAfterSecondRun.status).toBe(OutboxEventStatus.Succeeded);
    const [freshEventAfterSecondRun] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, freshPhoto.id));
    expect(freshEventAfterSecondRun.status).toBe(OutboxEventStatus.Processing);
    expect(freshEventAfterSecondRun.lockedAt).toBe(freshLockedAt);

    const eventCountAfterSecondRun = (await db.select().from(outboxEvents)).length;
    expect(eventCountAfterSecondRun).toBe(3);
  }, 20000);
});
