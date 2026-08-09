import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-128-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";

let app: import("express").Express;
let db: any;
let schema: any;
let cookie: string;

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  schema = await import("../src/db/schema");
  const { createAdminUser } = await import("../src/services/adminAuth");
  await createAdminUser(db, { email: "sprint128@example.com", password: "correct-password-128", role: "owner" });
  const login = await request(app).post("/api/auth/login").set("Origin", "http://localhost:3001").send({ email: "sprint128@example.com", password: "correct-password-128" });
  cookie = String(login.headers["set-cookie"]?.[0] ?? login.headers["set-cookie"]).split(";")[0];
});

describe("Sprint 128 payment operations detail", () => {
  it("reads one payment and only its deterministically ordered events through the repositories and safe use case", async () => {
    const { createTransactionPaymentRepositories } = await import("../src/repositories/payment/drizzle");
    const { getPaymentOperationsDetailUseCase } = await import("../src/use-cases/payment/useCases");
    db.insert(schema.payments).values({ id: "pay-ops", provider: "stripe", providerReference: "cs_test_safe", providerTransactionReference: "pi_test_safe", status: "manual_refund_required", amount: 12.34, expectedAmountCents: 1234, currency: "EUR", idempotencyKey: "ops-key", checkoutSnapshot: JSON.stringify({ guestEmail: "private@example.com", notes: "private" }), createdAt: "2026-08-10T10:00:00.000Z", updatedAt: "2026-08-10T10:03:00.000Z" }).run();
    db.insert(schema.paymentEvents).values([
      { id: "event-b", provider: "stripe", providerEventId: "evt_test_b", eventType: "checkout.session.completed", paymentId: "pay-ops", status: "manual_refund_required", resultClassification: "price_changed", errorCode: "CHECKOUT_PRICE_CHANGED", createdAt: "2026-08-10T10:02:00.000Z", updatedAt: "2026-08-10T10:03:00.000Z" },
      { id: "event-a", provider: "stripe", providerEventId: "evt_test_a", eventType: "checkout.session.completed", paymentId: "pay-ops", status: "completed", resultClassification: null, errorCode: null, createdAt: "2026-08-10T10:01:00.000Z", updatedAt: "2026-08-10T10:01:00.000Z" },
      { id: "event-other", provider: "stripe", providerEventId: "evt_test_other", eventType: "checkout.session.completed", paymentId: null, status: "completed", createdAt: "2026-08-10T09:00:00.000Z", updatedAt: "2026-08-10T09:00:00.000Z" },
    ]).run();
    const detail = await getPaymentOperationsDetailUseCase(createTransactionPaymentRepositories(db, "sqlite")).execute("pay-ops");
    expect(detail).toMatchObject({ paymentId: "pay-ops", expectedAmountCents: 1234, providerReference: "cs_test_safe", providerTransactionReference: "pi_test_safe", orderId: null });
    expect(detail.events.map((event) => event.providerEventId)).toEqual(["evt_test_a", "evt_test_b"]);
    expect(detail.events[0]).toMatchObject({ resultClassification: null, errorCode: null });
    expect(detail).not.toHaveProperty("checkoutSnapshot");
    expect(JSON.stringify(detail)).not.toContain("private@example.com");
  });

  it("requires Admin authentication and returns only the approved operational projection without mutation", async () => {
    expect((await request(app).get("/api/payments/pay-ops")).status).toBe(401);
    const before = db.select().from(schema.payments).all();
    const response = await request(app).get("/api/payments/pay-ops").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ paymentId: "pay-ops", provider: "stripe", expectedAmountCents: 1234, providerReference: "cs_test_safe", providerTransactionReference: "pi_test_safe" });
    expect(response.body.events[1]).toMatchObject({ id: "event-b", providerEventId: "evt_test_b", resultClassification: "price_changed", errorCode: "CHECKOUT_PRICE_CHANGED" });
    for (const field of ["checkoutSnapshot", "guestEmail", "billingAddress", "shippingAddress", "notes", "rawBody", "signature", "secret", "metadata"]) expect(response.body).not.toHaveProperty(field);
    expect(db.select().from(schema.payments).all()).toEqual(before);
  });

  it("returns not found safely and leaves the public status contract unchanged", async () => {
    const missing = await request(app).get("/api/payments/missing-payment").set("Cookie", cookie);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Payment not found" });
    const status = await request(app).get("/api/payments/pay-ops/status");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ status: "manual_refund_required" });
  });
});
