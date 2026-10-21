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

  it("exact-event route claims only the named due, unlocked photo event; everything else is untouched", async () => {
    const { default: app } = await import("../src/app");
    const { db } = await import("../src/db/client");
    const { SqliteOutboxRepository } = await import("../src/services/outboxRepository");
    const outbox = new SqliteOutboxRepository((db as any).$client);
    const route = "/api/background-jobs/product-photo-outbox/dispatch-event", auth = "Bearer test-scheduler-token-4c";
    const event = (id: string, eventType: string, aggregateId: string, extra: object = {}) => outbox.create({ id, eventType, aggregateType: "ProductPhoto", aggregateId, idempotencyKey: id, payload: { photoId: aggregateId, productId: "p" }, maxAttempts: 3, availableAt: "2026-01-01", ...extra } as never);
    await event("older-promote", "product_photo.promote_requested", "other-photo");
    await event("target-delete", "product_photo.delete_requested", "target-photo");
    await event("future-delete", "product_photo.delete_requested", "later-photo", { availableAt: "2999-01-01" });
    await event("stock", "stock_sync.requested", "product");
    (db as any).$client.prepare("UPDATE outbox_events SET status='Processing', locked_by='other-worker', locked_at='2026-01-01T00:00:00.000Z' WHERE id='older-promote'").run();
    const snapshot = () => (db as any).$client.prepare("SELECT id, status, attempt_count, locked_by, locked_at, available_at FROM outbox_events WHERE id <> 'target-delete' ORDER BY id").all();
    const before = snapshot();

    expect((await request(app).post(route).send({ eventId: "target-delete" })).status).toBe(401);
    expect((await request(app).post(route).set("Authorization", auth).send({})).status).toBe(400);
    expect((await request(app).post(route).set("Authorization", auth).send({ eventId: "../x" })).status).toBe(400);
    for (const id of ["stock", "future-delete", "older-promote", "missing"]) {
      const refused = await request(app).post(route).set("Authorization", auth).send({ eventId: id });
      expect(refused.status, id).toBe(409);
      expect(refused.body.code).toBe("OUTBOX_EVENT_NOT_CLAIMABLE");
    }
    const res = await request(app).post(route).set("Authorization", auth).send({ eventId: "target-delete" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ photoOutboxProcessed: 1, results: [{ eventId: "target-delete", attempts: 1 }] });
    // Fencing OFF keyless event: the existing W8 disposition; the claim and dispatch path is what is under test here.
    expect(await outbox.getById("target-delete")).toMatchObject({ status: "DeadLetter", lastErrorCode: "PHOTO_DELETE_KEYS_ABSENT" });
    expect(snapshot()).toEqual(before); // no other row claimed, requeued (stale lock kept) or dispatched
    expect((await request(app).post(route).set("Authorization", auth).send({ eventId: "target-delete" })).status).toBe(409);
  }, 60_000);
});

// PostgreSQL: the same parameterized-query proof as the existing claimNextBatch case (outbox.test.ts). Real-PostgreSQL
// execution is not claimed: the shared row parser JSON.parses the JSONB payload, a pre-existing PostgreSQL outbox
// defect that also affects getById/claimNextBatch and is outside 4C (PostgreSQL W8 deletion stays fail-closed).
describe("PostgreSQL claimById query (4C exact-event claim)", () => {
  it("binds id, worker, time and types as parameters with the batch claim's predicate and row lock", async () => {
    const { PostgresOutboxRepository } = await import("../src/services/outboxRepository");
    const calls: any[] = [];
    const repo = new PostgresOutboxRepository({ query: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return { rows: [] }; } });
    expect(await repo.claimById("w", "now", "evt", ["product_photo.delete_requested", "product_photo.promote_requested"])).toBeUndefined();
    expect(calls[0].params).toEqual(["w", "now", "evt", "product_photo.delete_requested", "product_photo.promote_requested"]);
    for (const part of ["WHERE id=$3", "status IN ('Pending','RetryPending')", "available_at <= $2", "locked_by IS NULL", "event_type IN ($4,$5)", "FOR UPDATE SKIP LOCKED"]) expect(calls[0].text).toContain(part);
    expect(calls[0].text).not.toContain("evt");
    expect(await repo.claimById("w", "now", "evt", [])).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
