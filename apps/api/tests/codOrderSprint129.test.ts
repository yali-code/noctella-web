import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType, StockMovementType } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-129-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";

let app: import("express").Express;
let db: any;
let schema: any;
let createProduct: any;
let categoryId: string;
const address = { fullName: "COD Buyer", line1: "1 Sofia Street", city: "Sofia", postalCode: "1000", country: "BG" };

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  schema = await import("../src/db/schema");
  createProduct = (await import("../src/services/products")).createProduct;
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "Sprint 129", displayOrder: 0, isActive: true });
  categoryId = category.id;
});

async function product(suffix: string, overrides: Record<string, unknown> = {}) {
  return createProduct(db, { sku: `COD-${suffix}`, title: `Canonical ${suffix}`, wooProductName: `Web ${suffix}`, slug: `cod-${suffix}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId, priceEur: 120, wooListingPriceEur: 100, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false, ...overrides });
}

function intent(orderDraftId: string, productIds: string[]) {
  return { orderDraftId, guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, notes: "COD", items: productIds.map((productId) => ({ productId, quantity: 1 })) };
}

/**
 * Sprint 135: each call sets a distinct synthetic X-Forwarded-For so this file's own many
 * requests to the now rate-limited POST /api/orders/cod (see middleware/codRateLimit.ts) are
 * correctly treated as independent clients, exactly as they would be under real, distinct
 * customer traffic - never as a way to weaken or bypass the limiter itself (see
 * codRateLimitSprint135.test.ts for the limiter's own dedicated, real-behavior tests).
 */
function postCod(clientIp: string, body: unknown) {
  return request(app).post("/api/orders/cod").set("X-Forwarded-For", clientIp).send(body);
}

describe("Sprint 129 COD order flow", () => {
  it("creates a server-authoritative pending COD order atomically without fabricated financial artifacts", async () => {
    const p = await product("woo");
    const paymentEventsBefore = await db.select().from(schema.paymentEvents);
    const response = await postCod("10.0.129.1", intent("cod-draft-woo", [p.id]));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: OrderStatus.Pending, paymentStatus: PaymentStatus.Pending, paymentProvider: PaymentProvider.CashOnDelivery, currency: "EUR", subtotalAmount: 100, totalAmount: 100 });
    expect(response.body.paymentReference ?? null).toBeNull();
    expect(response.body.items[0]).toMatchObject({ productTitle: "Web woo", unitPrice: 100, totalPrice: 100, currency: "EUR" });
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity).toBe(0);
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, response.body.id));
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe(StockMovementType.Sale);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, response.body.id))).toHaveLength(0);
    expect(await db.select().from(schema.paymentEvents)).toHaveLength(paymentEventsBefore.length);
    expect(await db.select().from(schema.invoices).where(eq(schema.invoices.orderId, response.body.id))).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, response.body.id))).toHaveLength(0);
  });

  it("rolls back order, items, inventory, movements, financial artifacts, and sync when a duplicate line conflicts during mutation", async () => {
    const p = await product("rollback");
    const before = {
      orderItems: (await db.select().from(schema.orderItems)).length,
      movements: (await db.select().from(schema.stockMovements)).length,
      payments: (await db.select().from(schema.payments)).length,
      paymentEvents: (await db.select().from(schema.paymentEvents)).length,
      invoices: (await db.select().from(schema.invoices)).length,
      outbox: (await db.select().from(schema.outboxEvents)).length,
      jobs: (await db.select().from(schema.backgroundJobs)).length,
    };
    const body = { ...intent("cod-rollback", [p.id]), items: [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 1 }] };
    const response = await postCod("10.0.129.2", body);
    expect(response.status).not.toBe(201);
    expect(await db.select().from(schema.orders).where(eq(schema.orders.orderDraftId, "cod-rollback"))).toHaveLength(0);
    expect(await db.select().from(schema.orderItems)).toHaveLength(before.orderItems);
    const persistedProduct = (await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0];
    expect(persistedProduct.stockQuantity).toBe(1);
    expect(persistedProduct.status).toBe(ProductStatus.Published);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(before.movements);
    expect(await db.select().from(schema.payments)).toHaveLength(before.payments);
    expect(await db.select().from(schema.paymentEvents)).toHaveLength(before.paymentEvents);
    expect(await db.select().from(schema.invoices)).toHaveLength(before.invoices);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(before.outbox);
    expect(await db.select().from(schema.backgroundJobs)).toHaveLength(before.jobs);
  });

  it("uses canonical price and title fallbacks", async () => {
    const p = await product("fallback", { wooProductName: null, wooListingPriceEur: null, priceEur: 75 });
    const response = await postCod("10.0.129.3", intent("cod-draft-fallback", [p.id]));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ subtotalAmount: 75, totalAmount: 75 });
    expect(response.body.items[0]).toMatchObject({ productTitle: "Canonical fallback", unitPrice: 75 });
  });

  it("rejects browser monetary/payment authority at validation", async () => {
    const p = await product("authority");
    const authorityCases = [{ subtotalAmount: 1 }, { totalAmount: 1 }, { currency: "USD" }, { paymentStatus: "paid" }, { paymentProvider: "stripe" }, { paymentReference: "fake" }];
    for (const [index, extra] of authorityCases.entries()) {
      const response = await postCod(`10.0.129.${10 + index}`, { ...intent(`cod-authority-${Object.keys(extra)[0]}`, [p.id]), ...extra });
      expect(response.status).toBe(400);
    }
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity).toBe(1);
  });

  it("rejects missing, unpublished, insufficient, invalid-quantity, and mixed COD-ineligible products without side effects", async () => {
    const eligible = await product("eligible");
    const ineligible = await product("ineligible", { allowCashOnDelivery: false });
    const draft = await product("draft", { status: ProductStatus.Draft });
    const empty = await product("empty", { stockQuantity: 0 });
    const cases = [
      intent("cod-missing", ["missing"]),
      intent("cod-draft", [draft.id]),
      intent("cod-empty", [empty.id]),
      intent("cod-mixed", [eligible.id, ineligible.id]),
      { ...intent("cod-quantity", [eligible.id]), items: [{ productId: eligible.id, quantity: 2 }] },
    ];
    for (const [index, body] of cases.entries()) expect((await postCod(`10.0.129.${20 + index}`, body)).status).toBe(index === 0 ? 404 : 400);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, eligible.id)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.orders).where(eq(schema.orders.orderDraftId, "cod-mixed"))).toHaveLength(0);
  });

  it("replays by orderDraftId without duplicate order, decrement, movement, or sync", async () => {
    const p = await product("replay");
    const first = await postCod("10.0.129.30", intent("cod-replay", [p.id]));
    const jobsBefore = (await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.productId, p.id))).length;
    const replay = await postCod("10.0.129.30", intent("cod-replay", [p.id]));
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity).toBe(0);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, first.body.id))).toHaveLength(1);
    expect(await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.productId, p.id))).toHaveLength(jobsBefore);
  });

  it("restores inventory once on cancellation and enqueues synchronization only after commit", async () => {
    const p = await product("cancel");
    const created = await postCod("10.0.129.31", intent("cod-cancel", [p.id]));
    const { SqliteUnitOfWork } = await import("../src/services/unitOfWork");
    const { transitionOrderStatusUseCase } = await import("../src/use-cases/order/useCases");
    let stockAtSync = -1;
    const sync = { enqueue: vi.fn(async () => { stockAtSync = Number((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity); }) };
    const transition = transitionOrderStatusUseCase(new SqliteUnitOfWork(db), undefined, undefined, "sqlite", sync);
    const cancelled = await transition.execute({ id: created.body.id, status: OrderStatus.Cancelled });
    expect(cancelled.status).toBe(OrderStatus.Cancelled);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, created.body.id))).toHaveLength(2);
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
    expect(stockAtSync).toBe(1);
    await transition.execute({ id: created.body.id, status: OrderStatus.Cancelled });
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, created.body.id))).toHaveLength(2);
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
  });

  it("calls COD stock synchronization only after the order transaction commits", async () => {
    const p = await product("sync");
    const { SqliteUnitOfWork } = await import("../src/services/unitOfWork");
    const { createCashOnDeliveryOrderUseCase } = await import("../src/use-cases/order/useCases");
    let stockAtSync = -1;
    const sync = { enqueue: vi.fn(async () => { stockAtSync = Number((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity); }) };
    const useCase = createCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db), sync);
    await useCase.execute(intent("cod-sync", [p.id]));
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
    expect(stockAtSync).toBe(0);
  });
});
