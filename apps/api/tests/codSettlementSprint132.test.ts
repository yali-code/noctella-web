import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-132-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";

let app: import("express").Express;
let db: any;
let schema: any;
let createProduct: any;
let categoryId: string;
let SqliteUnitOfWork: any;
let settleCashOnDeliveryOrderUseCase: any;
let codOutbox: { enqueue: (tx: any, orderId: string) => void };
const address = { fullName: "COD Buyer", line1: "1 Sofia Street", city: "Sofia", postalCode: "1000", country: "BG" };

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  schema = await import("../src/db/schema");
  createProduct = (await import("../src/services/products")).createProduct;
  ({ SqliteUnitOfWork } = await import("../src/services/unitOfWork"));
  ({ settleCashOnDeliveryOrderUseCase } = await import("../src/use-cases/order/useCases"));
  // Sprint 133: the same generic PaidOrderOutboxPort wiring services/orders.ts's real
  // settleCashOnDeliveryOrder uses - constructed locally here (matching this file's existing
  // direct-use-case-call convention, e.g. codOrderSprint129.test.ts's own inline `sync` port)
  // rather than importing the private paidOrderOutbox object services/orders.ts doesn't export.
  const { enqueueSalesInvoiceDraftForPaidOrderSync } = await import("../src/services/salesInvoiceOutbox");
  codOutbox = { enqueue: (tx, orderId) => enqueueSalesInvoiceDraftForPaidOrderSync(tx, orderId) };
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "Sprint 132", displayOrder: 0, isActive: true });
  categoryId = category.id;
});

async function product(suffix: string, overrides: Record<string, unknown> = {}) {
  return createProduct(db, { sku: `CODSET-${suffix}`, title: `Canonical ${suffix}`, wooProductName: `Web ${suffix}`, slug: `codset-${suffix}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId, priceEur: 120, wooListingPriceEur: 100, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false, ...overrides });
}

function intent(orderDraftId: string, productIds: string[]) {
  return { orderDraftId, guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, notes: "COD settlement", items: productIds.map((productId) => ({ productId, quantity: 1 })) };
}

/** Creates a real, server-authoritative Pending COD order through the existing public checkout route (Sprint 129) - never fabricated. */
async function createCodOrder(suffix: string, priceOverrides: Record<string, unknown> = {}) {
  const p = await product(suffix, priceOverrides);
  const response = await request(app).post("/api/orders/cod").send(intent(`cod-settle-${suffix}`, [p.id]));
  expect(response.status).toBe(201);
  return response.body;
}

/**
 * Directly seeds a minimal order row, bypassing every canonical creation use case - used only for
 * fixture states createCashOnDeliveryOrderUseCase can never itself produce (a non-COD provider, or
 * a COD order already in a terminal/non-Pending payment state). Never a stand-in for real
 * settlement behavior, which every other test in this file exercises through the real use case.
 */
function seedOrder(overrides: Record<string, unknown>) {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(schema.orders).values({
    id, orderNumber: `NOC-TEST-${id.slice(0, 8)}`, guestEmail: "buyer@example.com",
    status: OrderStatus.Pending, paymentStatus: PaymentStatus.Pending, paymentProvider: null, paymentReference: null,
    subtotalAmount: 100, totalAmount: 100, currency: "EUR",
    billingAddress: JSON.stringify(address), shippingAddress: JSON.stringify(address),
    createdAt: now, updatedAt: now, ...overrides,
  }).run();
  return id;
}

function settle(orderId: string, collectedAmount: number) {
  return settleCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db), codOutbox).execute({ orderId, collectedAmount });
}

describe("Sprint 132 COD settlement", () => {
  it("settles a Pending Cash on Delivery order atomically: Paid + exactly one canonical Payment + exactly one canonical PaymentEvent", async () => {
    const order = await createCodOrder("valid");
    const result = await settle(order.id, order.totalAmount);
    expect(result.replay).toBe(false);
    expect(result.order.paymentStatus).toBe(PaymentStatus.Paid);
    expect(result.order.status).toBe(OrderStatus.Pending);
    const payments = await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ provider: "cash_on_delivery", status: "paid", orderId: order.id, currency: "EUR", expectedAmountCents: Math.round(order.totalAmount * 100) });
    const events = await db.select().from(schema.paymentEvents).where(eq(schema.paymentEvents.paymentId, payments[0].id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "cash_on_delivery", providerEventId: `cod-settlement:${order.id}`, eventType: "cod.settled", status: "completed", paymentId: payments[0].id });
  });

  it("validates the collected amount via exact EUR cents - normalizes float-noise-prone totals, and rejects a genuine one-cent mismatch with no epsilon tolerance", async () => {
    const exact = await createCodOrder("cents", { priceEur: 19.99, wooListingPriceEur: 19.99 });
    expect(exact.totalAmount).toBe(19.99);
    const exactResult = await settle(exact.id, 19.99);
    expect(exactResult.order.paymentStatus).toBe(PaymentStatus.Paid);

    const mismatch = await createCodOrder("cents-mismatch", { priceEur: 19.99, wooListingPriceEur: 19.99 });
    await expect(settle(mismatch.id, 20.0)).rejects.toThrow(/does not match order total/);
    const fresh = (await db.select().from(schema.orders).where(eq(schema.orders.id, mismatch.id)))[0];
    expect(fresh.paymentStatus).toBe(PaymentStatus.Pending);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, mismatch.id))).toHaveLength(0);
  });

  it("rejects settlement for a non-Cash-on-Delivery order", async () => {
    const id = seedOrder({ paymentProvider: "stripe", paymentStatus: PaymentStatus.Paid });
    await expect(settle(id, 100)).rejects.toThrow(/not a Cash on Delivery order/);
  });

  it("rejects settlement for Cash on Delivery orders outside a Pending/Paid payment state", async () => {
    for (const paymentStatus of [PaymentStatus.Cancelled, PaymentStatus.Failed, PaymentStatus.ManualRefundRequired, PaymentStatus.Processing]) {
      const id = seedOrder({ paymentProvider: PaymentProvider.CashOnDelivery, paymentStatus });
      await expect(settle(id, 100)).rejects.toThrow(/not in a Pending payment state/);
    }
  });

  it("is idempotent on a coherent identical replay: no second Payment, no second PaymentEvent, no second invoice outbox row", async () => {
    const order = await createCodOrder("replay");
    const first = await settle(order.id, order.totalAmount);
    const second = await settle(order.id, order.totalAmount);
    expect(second.replay).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).toHaveLength(1);
    expect(await db.select().from(schema.paymentEvents).where(eq(schema.paymentEvents.paymentId, first.paymentId))).toHaveLength(1);
    // Sprint 133: the first-time settlement above enqueues exactly one durable
    // SalesInvoiceDraftRequested intent (see codSettlementInvoiceSprint133.test.ts for the full
    // outbox-identity/dispatch/draft-creation proof); the coherent replay must add no second row.
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, order.id))).toHaveLength(1);
  });

  it("fails closed on a divergent replay - a mismatched collectedAmount against an already-settled order is rejected, never auto-repaired", async () => {
    const order = await createCodOrder("divergent");
    await settle(order.id, order.totalAmount);
    await expect(settle(order.id, order.totalAmount + 1)).rejects.toThrow(/does not match/);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).toHaveLength(1);
    expect(await db.select().from(schema.paymentEvents).where(eq(schema.paymentEvents.paymentId, (await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)))[0].id))).toHaveLength(1);
  });

  it("rolls back Order.paymentStatus, Payment, and PaymentEvent together when the transaction fails mid-way", async () => {
    const order = await createCodOrder("rollback");
    (db as any).session.client.exec("CREATE TRIGGER sprint132_fail_cod_event BEFORE INSERT ON payment_events WHEN NEW.event_type = 'cod.settled' BEGIN SELECT RAISE(ABORT, 'forced Sprint 132 event failure'); END");
    try {
      await expect(settle(order.id, order.totalAmount)).rejects.toThrow(/forced Sprint 132 event failure/);
    } finally {
      (db as any).session.client.exec("DROP TRIGGER sprint132_fail_cod_event");
    }
    const fresh = (await db.select().from(schema.orders).where(eq(schema.orders.id, order.id)))[0];
    expect(fresh.paymentStatus).toBe(PaymentStatus.Pending);
    expect(await db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(schema.paymentEvents).where(eq(schema.paymentEvents.providerEventId, `cod-settlement:${order.id}`))).toHaveLength(0);
  });

  it("settles independently of shipment/fulfillment state - Delivered is not a prerequisite, and settlement never touches Shipment/Picking/Packing", async () => {
    const order = await createCodOrder("no-shipment");
    expect(await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id))).toHaveLength(0);
    const result = await settle(order.id, order.totalAmount);
    expect(result.order.paymentStatus).toBe(PaymentStatus.Paid);
    expect(await db.select().from(schema.shipments).where(eq(schema.shipments.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(schema.pickingTasks).where(eq(schema.pickingTasks.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(schema.packingTasks).where(eq(schema.packingTasks.orderId, order.id))).toHaveLength(0);
  });

  it("performs zero inventory mutation - stock and stock movements are unchanged by settlement", async () => {
    const order = await createCodOrder("inventory");
    const productId = order.items[0].productId;
    const stockBefore = (await db.select().from(schema.products).where(eq(schema.products.id, productId)))[0].stockQuantity;
    const movementsBefore = (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, order.id))).length;
    await settle(order.id, order.totalAmount);
    const stockAfter = (await db.select().from(schema.products).where(eq(schema.products.id, productId)))[0].stockQuantity;
    const movementsAfter = (await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, order.id))).length;
    expect(stockAfter).toBe(stockBefore);
    expect(movementsAfter).toBe(movementsBefore);
  });

  it("Sprint 133: a first-time settlement enqueues exactly one durable SalesInvoiceDraftRequested outbox intent, atomically with the settlement transaction", async () => {
    const order = await createCodOrder("outbox-intent");
    await settle(order.id, order.totalAmount);
    const rows = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "sales_invoice.draft_requested", aggregateType: "Order", idempotencyKey: `sales-invoice-draft:${order.id}` });
    expect(JSON.parse(rows[0].payload)).toEqual({ orderId: order.id });
  });
});
