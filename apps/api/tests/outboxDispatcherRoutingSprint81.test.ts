// Sprint 81 correction: the Product Photo and Sales Invoice outbox dispatchers each construct
// their own OutboxDispatcher instance, but both share the single outbox_events table. Before this
// fix, listPending/claimNextBatch claimed the oldest Pending/RetryPending row regardless of
// event_type, so a dispatcher with no matching handler could claim - and immediately dead-letter -
// an event that belonged to a different dispatcher entirely. These tests prove: (1) each
// dispatcher now claims only its own registered event types at the repository/dispatcher level,
// (2) the real production factories and the real scheduler HTTP route route mixed pending events
// correctly in one combined pass, and (3) the acceptance-database recovery sequence
// (FailedDeadLettered -> authorized retry -> Pending -> scheduler -> Succeeded) now works even
// with a competing Product Photo event pending at the same time - the exact condition that
// triggered the original defect.
// Deliberately NOT statically imported here: services/products.ts (and anything that transitively
// reaches services/photoStorage.ts) must only ever be imported dynamically in this file, and only
// AFTER PRODUCT_PHOTO_DIR is set for the scheduler-route test below. photoStorage.ts resolves its
// upload root from process.env.PRODUCT_PHOTO_DIR into a module-top-level const at import time
// (services/photoStorage.ts) - a static import anywhere in this file would resolve it once, too
// early, with the wrong (default, repo-relative) directory, for every test in the file.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { OutboxDispatcher, OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { SqliteOutboxRepository } from "../src/services/outboxRepository";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
const address = { fullName: "Sprint 81 Buyer", line1: "1 Test Way", city: "Paris", postalCode: "75001", country: "FR" };

describe("Sprint 81 correction: OutboxDispatcher claims only its own registered event types", () => {
  let sqlite: Database.Database; let repo: SqliteOutboxRepository;
  beforeEach(() => { sqlite = new Database(":memory:"); ensureSchema(sqlite); repo = new SqliteOutboxRepository(sqlite); });

  it("a dispatcher registered only for Product Photo events never claims a pending Sales Invoice event, and does not dead-letter it", async () => {
    await repo.create({ id: "inv-1", eventType: OutboxEventType.SalesInvoiceDraftRequested, aggregateType: "Order", aggregateId: "order-1", idempotencyKey: "key-inv-1", payload: { orderId: "order-1" }, maxAttempts: 5, availableAt: "2026-01-01T00:00:00.000Z" });
    const photoDispatcher = new OutboxDispatcher(repo);
    photoDispatcher.registerHandler({ eventType: OutboxEventType.ProductPhotoPromoteRequested, handle: vi.fn() });
    const results = await photoDispatcher.dispatchDueEvents("w", 10);
    expect(results).toHaveLength(0);
    const event = await repo.getById("inv-1");
    expect(event?.status).toBe(OutboxEventStatus.Pending);
    expect(event?.attemptCount).toBe(0);
  });

  it("a dispatcher registered only for Sales Invoice events never claims any pending Product Photo event", async () => {
    await repo.create({ id: "photo-1", eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-photo-1", payload: {}, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z" });
    await repo.create({ id: "photo-2", eventType: OutboxEventType.ProductPhotoDeleteRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-photo-2", payload: {}, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z" });
    await repo.create({ id: "photo-3", eventType: OutboxEventType.ProductPhotoCleanupTempRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-photo-3", payload: {}, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z" });
    const invoiceDispatcher = new OutboxDispatcher(repo);
    invoiceDispatcher.registerHandler({ eventType: OutboxEventType.SalesInvoiceDraftRequested, handle: vi.fn() });
    const results = await invoiceDispatcher.dispatchDueEvents("w", 10);
    expect(results).toHaveLength(0);
    for (const id of ["photo-1", "photo-2", "photo-3"]) expect((await repo.getById(id))?.status).toBe(OutboxEventStatus.Pending);
  });

  it("mixed pending events of both families are each claimed and succeed under their own dispatcher only, in a combined pass", async () => {
    await repo.create({ id: "photo-1", eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-photo-1", payload: {}, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z" });
    await repo.create({ id: "inv-1", eventType: OutboxEventType.SalesInvoiceDraftRequested, aggregateType: "Order", idempotencyKey: "key-inv-1", payload: {}, maxAttempts: 5, availableAt: "2026-01-01T00:00:00.000Z" });
    const photoHandle = vi.fn(); const invoiceHandle = vi.fn();
    const photoDispatcher = new OutboxDispatcher(repo);
    photoDispatcher.registerHandler({ eventType: OutboxEventType.ProductPhotoPromoteRequested, handle: photoHandle });
    const invoiceDispatcher = new OutboxDispatcher(repo);
    invoiceDispatcher.registerHandler({ eventType: OutboxEventType.SalesInvoiceDraftRequested, handle: invoiceHandle });

    // Mirrors the real /api/background-jobs/run route: photo dispatcher runs first.
    const photoResults = await photoDispatcher.dispatchDueEvents("w", 10);
    const invoiceResults = await invoiceDispatcher.dispatchDueEvents("w", 10);

    expect(photoResults.map(r => r.eventId)).toEqual(["photo-1"]);
    expect(invoiceResults.map(r => r.eventId)).toEqual(["inv-1"]);
    expect(photoHandle).toHaveBeenCalledTimes(1);
    expect(invoiceHandle).toHaveBeenCalledTimes(1);
    expect((await repo.getById("photo-1"))?.status).toBe(OutboxEventStatus.Succeeded);
    expect((await repo.getById("inv-1"))?.status).toBe(OutboxEventStatus.Succeeded);
    // Neither event was ever dead-lettered by the wrong dispatcher along the way.
    for (const id of ["photo-1", "inv-1"]) expect((await repo.getById(id))?.lastErrorMessage ?? null).toBeNull();
  });

  it("a dispatcher with zero registered handlers claims nothing, even when pending rows of every known type exist", async () => {
    await repo.create({ id: "photo-1", eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-photo-1", payload: {}, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z" });
    await repo.create({ id: "inv-1", eventType: OutboxEventType.SalesInvoiceDraftRequested, aggregateType: "Order", idempotencyKey: "key-inv-1", payload: {}, maxAttempts: 5, availableAt: "2026-01-01T00:00:00.000Z" });
    const emptyDispatcher = new OutboxDispatcher(repo);
    const results = await emptyDispatcher.dispatchDueEvents("w", 10);
    expect(results).toHaveLength(0);
    expect((await repo.getById("photo-1"))?.status).toBe(OutboxEventStatus.Pending);
    expect((await repo.getById("inv-1"))?.status).toBe(OutboxEventStatus.Pending);
  });

  it("explicitly dispatching a genuinely unregistered event still produces the existing permanent no-handler failure (unrelated to routing)", async () => {
    await repo.create({ id: "e", eventType: "some.unknown_type", aggregateType: "X", idempotencyKey: "key-unknown", payload: {}, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z" });
    const dispatcher = new OutboxDispatcher(repo);
    dispatcher.registerHandler({ eventType: OutboxEventType.ProductPhotoPromoteRequested, handle: vi.fn() });
    // dispatchEvent() dispatches a specific event id directly (e.g. an admin-triggered single-event
    // retry) and bypasses the type-scoped claim entirely - it still exercises the dispatcher's own
    // no-handler guard exactly as before. This behavior is intentionally unchanged by Sprint 81.
    const result = await dispatcher.dispatchEvent("e", "w");
    expect(result.status).toBe(OutboxEventStatus.DeadLetter);
    expect((await repo.getById("e"))?.lastErrorMessage).toContain("No handler registered");
  });

  it("normal handler permanent failures still dead-letter, and retry exhaustion still works, unaffected by type scoping", async () => {
    await repo.create({ id: "a", eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-a", payload: {}, maxAttempts: 1, availableAt: "2026-01-01T00:00:00.000Z" });
    const d = new OutboxDispatcher(repo, { maxAttempts: 1, nextDelayMs: () => 1, isPermanent: () => false });
    d.registerHandler({ eventType: OutboxEventType.ProductPhotoPromoteRequested, handle: async () => { throw new Error("boom"); } });
    await d.dispatchDueEvents("w", 1);
    const event = await repo.getById("a");
    expect(event?.status).toBe(OutboxEventStatus.DeadLetter);
    expect(event?.attemptCount).toBe(1);
  });
});

describe("Sprint 81 correction: PostgreSQL repository event-type scoping (source/query-shape audit, not live execution)", () => {
  it("claimNextBatch and listPending both parameterize the event-type predicate and never interpolate values into SQL", async () => {
    const { PostgresOutboxRepository } = await import("../src/services/outboxRepository");
    const calls: any[] = [];
    const pg = new PostgresOutboxRepository({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
    await pg.claimNextBatch("w", "now", 5, [OutboxEventType.SalesInvoiceDraftRequested]);
    await pg.listPending("now", 5, [OutboxEventType.ProductPhotoPromoteRequested, OutboxEventType.ProductPhotoDeleteRequested]);
    expect(calls[0].sql).toMatch(/event_type IN \(\$3\)/);
    expect(calls[0].sql).not.toContain(OutboxEventType.SalesInvoiceDraftRequested);
    expect(calls[0].params).toEqual(["w", "now", OutboxEventType.SalesInvoiceDraftRequested, 5]);
    expect(calls[1].sql).toMatch(/event_type IN \(\$2,\$3\)/);
    expect(calls[1].params).toEqual(["now", OutboxEventType.ProductPhotoPromoteRequested, OutboxEventType.ProductPhotoDeleteRequested, 5]);
  });
});

describe("Sprint 81 correction: real scheduler route dispatches mixed outbox event types correctly", () => {
  it("POST /api/background-jobs/run processes one pending Product Photo event and one pending Sales Invoice event, each via its correct handler, with no cross-claim and no false dead-letter", async () => {
    process.env.DATABASE_URL = ":memory:";
    process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-sprint81-tests";
    process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
    process.env.SCHEDULER_AUTH_TOKEN = "sprint81-scheduler-token";
    const os = await import("node:os"); const path = await import("node:path"); const fs = await import("node:fs/promises");
    process.env.PRODUCT_PHOTO_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "noctella-outbox-routing-sprint81-"));

    const { default: app } = await import("../src/app");
    const request = (await import("supertest")).default;
    const sharp = (await import("sharp")).default;
    const { db } = await import("../src/db/client");
    const { uploadProductPhoto, createProduct } = await import("../src/services/products");
    const { createCategory } = await import("../src/services/categories");
    const { createOrder } = await import("../src/services/orders");
    const { createPaymentSession } = await import("../src/payments/paymentRepository");
    const { upsertCompanyProfile } = await import("../src/services/companyProfile");
    const { listInvoices } = await import("../src/services/erpSalesFinanceBridge");
    const { enqueueSalesInvoiceDraftForPaidOrder, salesInvoiceDraftIdempotencyKey } = await import("../src/services/salesInvoiceOutbox");

    await upsertCompanyProfile(db, { legalName: "Sprint 81 Routing Test Ltd.", registrationNumber: "T-R81", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 });
    const category = await createCategory(db, { name: "Sprint81-Routing-Cat", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-R81", title: "Routing Product", slug: "routing-product-r81", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 150, stockQuantity: 1, images: [] });

    // A genuine pending Product Photo promote event via the real upload path (real LocalPhotoStorage
    // + sharp, exactly as production does) so the real ProductPhotoPromotionHandler genuinely
    // succeeds, not just avoids crashing on invalid image data.
    const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const photo = await uploadProductPhoto(db, product.id, { buffer, mimetype: "image/png", size: buffer.length });
    expect(photo.processingStatus).toBe("Processing");

    // A genuine pending Sales Invoice Draft event, created WITHOUT the post-commit best-effort
    // dispatch (enqueueInvoiceDraft:false) so it remains Pending until the scheduler route runs -
    // reproducing the exact acceptance scenario where both event types are pending simultaneously.
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "r81-ref", status: PaymentStatus.Paid, amount: 150, currency: "EUR", idempotencyKey: "r81-pay" });
    const order = await createOrder(db, { orderDraftId: "r81-draft", guestEmail: "buyer@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "r81-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 150, totalAmount: 150, items: [{ productId: product.id, quantity: 1 as const }] }, { enqueueInvoiceDraft: false });
    await enqueueSalesInvoiceDraftForPaidOrder(db, order.id);
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);

    const res = await request(app).post("/api/background-jobs/run").set("Authorization", "Bearer sprint81-scheduler-token").send({});
    expect(res.status).toBe(200);
    expect(res.body.photoOutboxProcessed).toBe(1);
    expect(res.body.salesInvoiceOutboxProcessed).toBe(1);

    const [photoEvent] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.idempotencyKey, `product-photo-promote:${photo.id}`));
    const [invoiceEvent] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.idempotencyKey, salesInvoiceDraftIdempotencyKey(order.id)));
    expect(photoEvent.status).toBe(OutboxEventStatus.Succeeded);
    expect(invoiceEvent.status).toBe(OutboxEventStatus.Succeeded);
    expect(photoEvent.lastErrorMessage).not.toBe("No handler registered");
    expect(invoiceEvent.lastErrorMessage).not.toBe("No handler registered");

    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items).toHaveLength(1);
  }, 20000);
});

describe("Sprint 81 correction: acceptance-database recovery sequence works with a competing Product Photo event pending", () => {
  let db: any; let sqlite: Database.Database;
  beforeEach(() => { const m = memoryDb(); db = m.db; sqlite = m.sqlite; });

  it("FailedDeadLettered -> authorized retry (same row, attemptCount reset to 0) -> Pending -> scheduler -> Succeeded -> exactly one Draft SalesInvoice, with no duplicate event or invoice, even while a Product Photo event is also pending", async () => {
    const { createCategory } = await import("../src/services/categories");
    const { createProduct } = await import("../src/services/products");
    const { createOrder } = await import("../src/services/orders");
    const { createPaymentSession } = await import("../src/payments/paymentRepository");
    const { upsertCompanyProfile } = await import("../src/services/companyProfile");
    const { listInvoices } = await import("../src/services/erpSalesFinanceBridge");
    const { dispatchDueProductPhotoOutboxEvents } = await import("../src/services/productPhotoOutboxDispatcher");
    const { dispatchDueSalesInvoiceOutboxEvents, enqueueSalesInvoiceDraftForPaidOrder, retrySalesInvoiceDraftForOrder, salesInvoiceDraftIdempotencyKey } = await import("../src/services/salesInvoiceOutbox");

    await upsertCompanyProfile(db, { legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 });
    const category = await createCategory(db, { name: "Recovery-cat", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-RECOVERY", title: "Recovery Product", slug: "recovery-product", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 120, stockQuantity: 1, images: [] });
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "recovery-ref", status: PaymentStatus.Paid, amount: 120, currency: "EUR", idempotencyKey: "recovery-pay" });
    const order = await createOrder(db, { orderDraftId: "recovery-draft", guestEmail: "buyer@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "recovery-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 120, totalAmount: 120, items: [{ productId: product.id, quantity: 1 as const }] }, { enqueueInvoiceDraft: false });
    const enqueued = await enqueueSalesInvoiceDraftForPaidOrder(db, order.id);

    // Simulate a historical row left DeadLetter by the pre-fix routing defect (attemptCount:1,
    // "No handler registered") - the exact state the real acceptance database was reported in.
    const deadLetteredAt = new Date().toISOString();
    await db.update(schema.outboxEvents).set({ status: OutboxEventStatus.DeadLetter, attemptCount: 1, deadLetteredAt, lastErrorCode: "OUTBOX_NO_HANDLER", lastErrorMessage: "No handler registered", lockedAt: null, lockedBy: null, updatedAt: deadLetteredAt }).where(eq(schema.outboxEvents.id, (enqueued as any).id));

    // A competing, genuinely pending Product Photo event - proving the fixed routing keeps it
    // untouched by the Sales Invoice recovery path and vice versa.
    const photoRepo = new SqliteOutboxRepository(sqlite);
    await photoRepo.create({ id: "recovery-photo-1", eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", idempotencyKey: "key-recovery-photo-1", payload: {}, maxAttempts: 3, availableAt: new Date().toISOString() });

    const retryResult = await retrySalesInvoiceDraftForOrder(db, order.id);
    expect(retryResult).toEqual({ retried: true, reason: "Reactivated" });
    const [reactivated] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, (enqueued as any).id));
    expect(reactivated.id).toBe((enqueued as any).id);
    expect(reactivated.status).toBe(OutboxEventStatus.Pending);
    expect(reactivated.attemptCount).toBe(0);
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(0);

    await dispatchDueProductPhotoOutboxEvents(db, "test-worker", 10);
    await dispatchDueSalesInvoiceOutboxEvents(db, "test-worker", 10);

    const [succeeded] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, (enqueued as any).id));
    expect(succeeded.status).toBe(OutboxEventStatus.Succeeded);
    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items).toHaveLength(1);

    // The competing Product Photo event was claimed and handled by its OWN dispatcher only - the
    // real ProductPhotoPromotionHandler treats a payload with no matching photo row as an idempotent
    // no-op (Succeeded), never "No handler registered" - proving it was never left for, or stolen
    // by, the Sales Invoice recovery path.
    const [photoAfter] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, "recovery-photo-1"));
    expect(photoAfter.status).toBe(OutboxEventStatus.Succeeded);
    expect(photoAfter.lastErrorMessage).not.toBe("No handler registered");

    // No duplicate event row was created for the same order.
    const allEventsForOrder = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.idempotencyKey, salesInvoiceDraftIdempotencyKey(order.id)));
    expect(allEventsForOrder).toHaveLength(1);

    // Retrying again once the invoice already exists is reported, not repeated - no duplicate invoice.
    const noopRetry = await retrySalesInvoiceDraftForOrder(db, order.id);
    expect(noopRetry).toEqual({ retried: false, reason: "AlreadyCreated", invoiceId: invoices.items[0].id });
    expect((await listInvoices(db, { orderId: order.id })).items).toHaveLength(1);
  });
});
