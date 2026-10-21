// 4C (#424): POST /api/background-jobs/product-photo-outbox/run dispatches only the product-photo outbox, behind the
// scheduler token and batch bound; other due outbox domains stay untouched. Env is read at import time (see
// productPhotoOutboxScheduler.test.ts), so it is set before src/app.ts is imported.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-4c";
process.env.PRODUCT_PHOTO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-4c-route-"));

describe("photo-only scheduler invocation (4C)", () => {
  it("requires the scheduler token, bounds the batch, and dispatches only product-photo events", async () => {
    const { default: app } = await import("../src/app");
    const { db } = await import("../src/db/client");
    const { SqliteOutboxRepository } = await import("../src/services/outboxRepository");
    const outbox = new SqliteOutboxRepository((db as any).$client);
    const route = "/api/background-jobs/product-photo-outbox/run";

    expect((await request(app).post(route).send({})).status).toBe(401);
    expect((await request(app).post(route).set("Authorization", "Bearer wrong").send({})).status).toBe(401);
    expect((await request(app).post(route).set("Authorization", "Bearer test-scheduler-token-4c").send({ batchSize: 11 })).status).toBe(400);

    await outbox.create({ id: "photo-delete", eventType: "product_photo.delete_requested", aggregateType: "ProductPhoto", aggregateId: "ph", idempotencyKey: "photo-delete", payload: { photoId: "ph", productId: "p" }, maxAttempts: 3, availableAt: "2026-01-01" } as never);
    await outbox.create({ id: "invoice", eventType: "sales_invoice.draft_requested", aggregateType: "Order", aggregateId: "o", idempotencyKey: "invoice", payload: { orderId: "o" }, maxAttempts: 3, availableAt: "2026-01-01" } as never);
    const res = await request(app).post(route).set("Authorization", "Bearer test-scheduler-token-4c").send({});
    expect(res.status).toBe(200);
    expect(res.body.photoOutboxProcessed).toBe(1);
    expect(res.body.results).toEqual([expect.objectContaining({ eventId: "photo-delete" })]);
    // Fencing OFF keyless production event: dead-lettered, never acknowledged as a deletion (existing W8 behavior).
    expect(await outbox.getById("photo-delete")).toMatchObject({ status: "DeadLetter", lastErrorCode: "PHOTO_DELETE_KEYS_ABSENT" });
    expect(await outbox.getById("invoice")).toMatchObject({ status: "Pending", attemptCount: 0 });
  }, 60_000);
});
