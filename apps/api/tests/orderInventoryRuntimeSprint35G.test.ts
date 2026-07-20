import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder, createSaleRollback } from "../src/services/orders";
import { createOrderSchema } from "../src/validation/order";
import { decreaseInventoryForSaleInTransactionUseCase, restoreInventoryForSaleRollbackInTransactionUseCase } from "../src/application/inventory";
import { createSaleRollbackUseCase } from "../src/use-cases/order/useCases";
import { createTestDb } from "./testDb";

const time = "2026-01-01T00:00:00.000Z";
async function harness() {
  const db = createTestDb();
  const category = await createCategory(db, { name: "Runtime", displayOrder: 0, isActive: true });
  const product = await createProduct(db, {
    sku: "ORDER-RUNTIME-1", title: "Runtime item", slug: "runtime-item", type: ProductType.UniqueItem,
    status: ProductStatus.Published, categoryId: category.id, customsWarning: false, isFeatured: false,
    allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 10,
    images: [],
  });
  const input = createOrderSchema.parse({
    orderDraftId: "draft-runtime", guestEmail: "buyer@example.com", status: OrderStatus.Pending,
    paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "payment-runtime",
    currency: "EUR", billingAddress: { fullName: "A", line1: "B", city: "C", postalCode: "D", country: "E" },
    shippingAddress: { fullName: "A", line1: "B", city: "C", postalCode: "D", country: "E" },
    subtotalAmount: 10, totalAmount: 10, items: [{ productId: product.id, quantity: 1 }],
  });
  return { db, product, input };
}

describe("Sprint 35G order Inventory runtime", () => {
  test("order creation decrements Inventory and records one movement exactly once", async () => {
    const { db, product, input } = await harness();
    const first = await createOrder(db, input);
    const duplicate = await createOrder(db, { ...input, paymentReference: "ignored-replay" });
    expect(duplicate.id).toBe(first.id);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(0);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.productId, product.id))).toHaveLength(1);
  });

  test("order failure leaves no partial Inventory mutation", async () => {
    const { db, product, input } = await harness();
    await expect(createOrder(db, { ...input, subtotalAmount: 9, totalAmount: 9 })).rejects.toBeTruthy();
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
    expect(await db.select().from(schema.orders)).toHaveLength(0);
  });

  test("sale rollback restores Inventory and records one movement exactly once", async () => {
    const { db, product, input } = await harness();
    const order = await createOrder(db, input);
    await createSaleRollback(db, { orderId: order.id, idempotencyKey: "rollback-1", reason: "test" });
    await createSaleRollback(db, { orderId: order.id, idempotencyKey: "rollback-1", reason: "test" });
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.productId, product.id))).toHaveLength(2);
    expect((await db.select().from(schema.orders).where(eq(schema.orders.id, order.id)))[0].status).toBe(OrderStatus.Cancelled);
  });

  test("SQLite callbacks remain synchronous", async () => {
    const { db, input } = await harness();
    const order = await createOrder(db, input);
    await expect(createSaleRollback(db, { orderId: order.id, idempotencyKey: "rollback-sync" })).resolves.toBeTruthy();
  });

  test("rollback failure preserves the existing error", async () => {
    const failure = new Error("sales rollback failed");
    const useCase = createSaleRollbackUseCase({ run: async () => { throw failure; } } as any);
    await expect(useCase.execute({ orderId: "order", idempotencyKey: "rollback-failure" })).rejects.toBe(failure);
  });

  test("PostgreSQL-style Inventory execution remains asynchronous", async () => {
    const repositories: any = {
      products: { update: vi.fn().mockResolvedValue({}) },
      inventory: { findByProduct: vi.fn().mockResolvedValue({ productId: "p", locationId: null, quantity: 2, updatedAt: time }), updateWithVersion: vi.fn().mockResolvedValue({ productId: "p", locationId: null, quantity: 1, updatedAt: time }) },
      stockMovements: { findByIdempotencyKey: vi.fn().mockResolvedValue(null), append: vi.fn().mockResolvedValue({ id: "m", productId: "p", type: "sale", quantityDelta: -1, stockBefore: 2, stockAfter: 1, orderId: "o", orderItemId: "i", note: null, idempotencyKey: "k", createdAt: time, updatedAt: time }) },
    };
    const execution = decreaseInventoryForSaleInTransactionUseCase({ clock: { now: () => new Date(time) }, idGenerator: { newId: () => "m" } }, repositories, { productId: "p", quantity: 1, orderId: "o", orderItemId: "i", idempotencyKey: "k" });
    expect(execution).toBeInstanceOf(Promise);
    await expect(execution).resolves.toMatchObject({ inventory: { quantity: 1 } });
    const restore = restoreInventoryForSaleRollbackInTransactionUseCase({ clock: { now: () => new Date(time) }, idGenerator: { newId: () => "r" } }, { ...repositories, inventory: { findByProduct: vi.fn().mockResolvedValue({ productId: "p", locationId: null, quantity: 1, updatedAt: time }), updateWithVersion: vi.fn().mockResolvedValue({ productId: "p", locationId: null, quantity: 2, updatedAt: time }) }, stockMovements: { findByIdempotencyKey: vi.fn().mockResolvedValue(null), append: vi.fn().mockResolvedValue({ id: "r", productId: "p", type: "sale_rollback", quantityDelta: 1, stockBefore: 1, stockAfter: 2, orderId: "o", orderItemId: "i", note: null, idempotencyKey: "r", createdAt: time, updatedAt: time }) } }, { productId: "p", quantity: 1, orderId: "o", orderItemId: "i", idempotencyKey: "r" });
    expect(restore).toBeInstanceOf(Promise);
    await expect(restore).resolves.toMatchObject({ inventory: { quantity: 2 } });
  });

  test("migrated paths contain no direct legacy stock mutation", () => {
    const source = readFileSync(new URL("../src/use-cases/order/useCases.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/repositories\.stock\.stockMovements\.(read|getBalance|write|create)/);
    expect(source).toContain("decreaseInventoryForSaleInTransactionUseCase");
    expect(source).toContain("restoreInventoryForSaleRollbackInTransactionUseCase");
  });
});
