import { ProductStatus, ProductType, StockMovementType } from "@noctella/shared";
import { describe, expect, test } from "vitest";
import { createIncreaseInventoryUseCase } from "../src/application/inventory";
import { createInventoryRepositoryBundleForDb } from "../src/repositories/inventory/factory";
import { createInventoryApplicationContextForDb } from "../src/services/inventoryApplicationContextForDb";
import { createTestDb } from "./testDb";

const v1 = "2026-07-19T00:00:00.000Z";
const v2 = "2026-07-19T00:01:00.000Z";

async function harness() {
  const db = createTestDb();
  const repositories = createInventoryRepositoryBundleForDb(db, "sqlite");
  await repositories.products.create({
    id: "p1", sku: "SKU1", title: "T", slug: "t",
    type: ProductType.UniqueItem, status: ProductStatus.Draft,
    priceEur: 10, stockQuantity: 5, purchaseCurrency: "EUR",
    createdAt: v1, updatedAt: v1,
  });
  return { db, repositories, context: createInventoryApplicationContextForDb(db, "sqlite") };
}

describe("Sprint 35D synchronous SQLite Inventory execution", () => {
  test("managed transaction callback and scoped persistence remain synchronous", async () => {
    const { context } = await harness();
    const result = context.unitOfWork.run(({ repositories }) => {
      const state = repositories.inventoryRepositories.inventory.updateWithVersion("p1", 6, v1, v2);
      expect(state).not.toBeInstanceOf(Promise);
      return state;
    });
    expect(result).not.toBeInstanceOf(Promise);
  });

  test("successful use case commits balance and movement", async () => {
    const { context, repositories } = await harness();
    await createIncreaseInventoryUseCase(context).execute({ productId: "p1", quantity: 2, expectedVersion: v1, idempotencyKey: "increase-1" });
    expect((await repositories.inventory.findByProduct("p1"))?.quantity).toBe(7);
    expect(await repositories.stockMovements.listByProduct("p1")).toHaveLength(1);
  });

  test("failure rolls back balance and movement without partial persistence", async () => {
    const { context, repositories } = await harness();
    expect(() => context.unitOfWork.run(({ repositories: scoped }) => {
      scoped.inventoryRepositories.inventory.updateWithVersion("p1", 4, v1, v2);
      scoped.inventoryRepositories.stockMovements.append({
        id: "m1", productId: "p1", type: StockMovementType.Sale,
        quantityDelta: -1, stockBefore: 5, stockAfter: 4,
        orderId: null, orderItemId: null, note: null,
        idempotencyKey: "rollback-1", createdAt: v2, updatedAt: v2,
      });
      throw new Error("IN_TRANSACTION_FAILURE");
    })).toThrow("IN_TRANSACTION_FAILURE");
    expect((await repositories.inventory.findByProduct("p1"))?.quantity).toBe(5);
    expect(await repositories.stockMovements.listByProduct("p1")).toHaveLength(0);
  });

  test("PostgreSQL repository execution stays asynchronous", () => {
    const query = Promise.resolve([]);
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => query }) }) }) };
    expect(createInventoryRepositoryBundleForDb(db, "postgres").products.findById("p1")).toBeInstanceOf(Promise);
  });

  test("driver and execution capability mismatch is rejected", () => {
    expect(() => createInventoryRepositoryBundleForDb({}, "postgres", "synchronous")).toThrow("INVENTORY_TRANSACTION_CAPABILITY_DRIVER_MISMATCH");
  });
});
