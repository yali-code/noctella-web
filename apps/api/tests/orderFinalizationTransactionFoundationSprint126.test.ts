import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { enqueueSalesInvoiceDraftForPaidOrderSync } from "../src/services/salesInvoiceOutbox";
import { createInternalOrderUseCase, finalizeInternalOrderInTransaction } from "../src/use-cases/order/useCases";
import { createTestDb } from "./testDb";

const now = new Date("2026-08-10T12:00:00.000Z");
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };

async function fixture() {
  const db = createTestDb();
  const category = await createCategory(db, { name: `Foundation ${randomUUID()}`, displayOrder: 0, isActive: true });
  const product = await createProduct(db, {
    sku: `FOUNDATION-${randomUUID()}`,
    title: "Canonical Camera",
    wooProductName: "Noctella Camera",
    slug: `foundation-${randomUUID()}`,
    type: ProductType.UniqueItem,
    status: ProductStatus.Published,
    categoryId: category.id,
    priceEur: 120,
    wooListingPriceEur: 100,
    stockQuantity: 1,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
  });
  const input = {
    orderDraftId: `draft-${randomUUID()}`,
    channel: "Internal" as const,
    guestEmail: "buyer@example.invalid",
    status: OrderStatus.Processing,
    paymentStatus: PaymentStatus.Paid,
    paymentProvider: PaymentProvider.Stripe,
    paymentReference: `payment-${randomUUID()}`,
    currency: "EUR",
    billingAddress: address,
    shippingAddress: address,
    subtotalAmount: 100,
    totalAmount: 100,
    items: [{ productId: product.id, quantity: 1 }],
  };
  return { db, product, input };
}

function context(repositories: any, input: any, orderId: string, outbox = { enqueue: enqueueSalesInvoiceDraftForPaidOrderSync }, inventoryDriver: "sqlite" | "test-memory" = "sqlite") {
  let id = 0;
  return {
    repositories,
    clock: { now: () => now },
    idGenerator: { id: () => `${orderId}-id-${++id}` },
    inventoryDriver,
    outbox,
    pricingContext: "noctella_web" as const,
    paidSession: { amount: 100, currency: "EUR" },
    orderId,
    idempotencyKey: input.orderDraftId,
  };
}

describe("Sprint 126 transaction-scoped order finalization foundation", () => {
  it("composes synchronously inside an externally opened UnitOfWork and commits the canonical graph", async () => {
    const { db, product, input } = await fixture();
    const uow = new SqliteUnitOfWork(db);
    const orderId = `order-${randomUUID()}`;
    const result = await uow.run(({ repositories }) => {
      const value = finalizeInternalOrderInTransaction(input, context(repositories, input, orderId));
      expect(value).not.toBeInstanceOf(Promise);
      return value;
    });

    expect(result.order).toMatchObject({ id: orderId, subtotalAmount: 100, totalAmount: 100 });
    expect(result.order.items[0]).toMatchObject({ productTitle: "Noctella Camera", unitPrice: 100, totalPrice: 100 });
    expect(result.affectedProductIds).toEqual([product.id]);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(0);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, orderId))).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, orderId))).toHaveLength(1);
  });

  it("rolls back order, items, inventory, movement and outbox when finalization fails before commit", async () => {
    const { db, product, input } = await fixture();
    const orderId = `order-${randomUUID()}`;
    const failure = new Error("OUTBOX_TEST_FAILURE");
    await expect(new SqliteUnitOfWork(db).run(({ repositories }) => finalizeInternalOrderInTransaction(input, context(repositories, input, orderId, { enqueue: () => { throw failure; } })))).rejects.toBe(failure);

    expect(await db.select().from(schema.orders).where(eq(schema.orders.id, orderId))).toHaveLength(0);
    expect(await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId))).toHaveLength(0);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, orderId))).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, orderId))).toHaveLength(0);
  });

  it("preserves Promise-returning inventory-driver ordering without a Sprint 126 rejection", async () => {
    const { db, product, input } = await fixture();
    let repositories: any;
    await new SqliteUnitOfWork(db).run((scope) => { repositories = scope.repositories; });
    const orderId = `order-${randomUUID()}`;
    let stockWhenOutboxEnqueued = -1;
    const outbox = {
      enqueue: () => {
        stockWhenOutboxEnqueued = Number((db.select().from(schema.products).where(eq(schema.products.id, product.id)) as any).get().stockQuantity);
      },
    };

    const execution = finalizeInternalOrderInTransaction(input, context(repositories, input, orderId, outbox, "test-memory"));
    expect(execution).toBeInstanceOf(Promise);
    const result = await execution;

    expect(result.order.id).toBe(orderId);
    expect(result.affectedProductIds).toEqual([product.id]);
    expect(stockWhenOutboxEnqueued).toBe(0);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(0);
  });

  it("returns an empty affected list on durable replay and creates no duplicate side effects", async () => {
    const { db, product, input } = await fixture();
    const uow = new SqliteUnitOfWork(db);
    const firstId = `order-${randomUUID()}`;
    const first = await uow.run(({ repositories }) => finalizeInternalOrderInTransaction(input, context(repositories, input, firstId)));
    const replay = await uow.run(({ repositories }) => finalizeInternalOrderInTransaction(input, context(repositories, input, `unused-${randomUUID()}`)));

    expect(replay.order.id).toBe(first.order.id);
    expect(replay.affectedProductIds).toEqual([]);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(0);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, first.order.id))).toHaveLength(1);
    expect(await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, first.order.id))).toHaveLength(1);
  });

  it("keeps stock synchronization in the wrapper after commit and omits it on replay or failure", async () => {
    const { db, product, input } = await fixture();
    let committedStock = -1;
    const sync = { enqueue: vi.fn(async () => { committedStock = Number((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity); }) };
    const uow = new SqliteUnitOfWork(db);
    const run = vi.spyOn(uow, "run");
    const useCase = createInternalOrderUseCase(uow, sync, { now: () => now }, { id: () => randomUUID() }, "sqlite", undefined, "noctella_web", { amount: 100, currency: "EUR" });

    await useCase.execute(input);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
    expect(committedStock).toBe(0);
    await useCase.execute(input);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sync.enqueue).toHaveBeenCalledTimes(1);

    const unavailable = { ...input, orderDraftId: `draft-${randomUUID()}`, paymentReference: `payment-${randomUUID()}` };
    await expect(useCase.execute(unavailable)).rejects.toThrow(/published|stock/i);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sync.enqueue).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(0);
  });
});
