import { describe, expect, test, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { createInventoryRepositoryBundleForDb } from "../src/repositories/inventory/factory";
import { createInventoryApplicationContextForDb, createInventoryTransactionCapabilityForDb } from "../src/services/inventoryApplicationContextForDb";
import { buildInventoryApplicationContext } from "../src/services/inventoryApplicationContext";
import { createIncreaseInventoryUseCase } from "../src/application/inventory";
import { StaleInventoryVersionError } from "../src/repositories/inventory/errors";
import { InventoryVersionConflictError } from "../src/application/inventory/errors";

const time = "2026-01-01T00:00:00.000Z";

async function sqliteHarness() {
  const db = createTestDb();
  const repositories = createInventoryRepositoryBundleForDb(db, "sqlite");
  await repositories.products.create({
    id: "p1", sku: "SKU1", title: "T", slug: "t",
    type: ProductType.UniqueItem, status: ProductStatus.Draft,
    priceEur: 1, stockQuantity: 5, purchaseCurrency: "EUR",
    createdAt: time, updatedAt: time,
  });
  const context = createInventoryApplicationContextForDb(db, "sqlite");
  return { db, context, repositories };
}

describe("Sprint 35D Inventory driver-aware transaction runtime", () => {
  test("synchronous SQLite commits balance and movement", async () => {
    const { context, repositories } = await sqliteHarness();
    const result = await createIncreaseInventoryUseCase(context).execute({ productId: "p1", quantity: 1, expectedVersion: time });
    expect(result.quantity).toBe(6);
    expect(await repositories.stockMovements.listByProduct("p1")).toHaveLength(1);
  });

  test("synchronous SQLite throw rolls back without partial persistence", async () => {
    const { db, repositories } = await sqliteHarness();
    const context = buildInventoryApplicationContext({ repositories, unitOfWork: createInventoryTransactionCapabilityForDb(db, "sqlite") as any, clock: { now: () => new Date(time) }, idGenerator: { newId: () => "movement" }, logger: {} });
    const first = await createIncreaseInventoryUseCase(context).execute({ productId: "p1", quantity: 1, expectedVersion: time });
    await expect(createIncreaseInventoryUseCase(context).execute({ productId: "p1", quantity: 1, expectedVersion: first.updatedAt })).rejects.toThrow();
    expect((await repositories.inventory.findByProduct("p1"))?.quantity).toBe(6);
    expect(await repositories.stockMovements.listByProduct("p1")).toHaveLength(1);
  });

  test("rejected asynchronous repository errors retain use-case mapping", async () => {
    const repositories: any = {
      products: {}, inventory: { findByProduct: vi.fn().mockResolvedValue({ productId: "p1", locationId: null, quantity: 5, updatedAt: time }), updateWithVersion: vi.fn().mockRejectedValue(new StaleInventoryVersionError("p1")) },
      stockMovements: { findByIdempotencyKey: vi.fn().mockResolvedValue(null), append: vi.fn() }, stockLocations: {},
    };
    const context = buildInventoryApplicationContext({ repositories, unitOfWork: { run: (work) => Promise.resolve(work({ repositories: { inventoryRepositories: repositories } })) }, clock: { now: () => new Date(time) }, idGenerator: { newId: () => "m" }, logger: {} });
    await expect(createIncreaseInventoryUseCase(context).execute({ productId: "p1", quantity: 1, expectedVersion: time })).rejects.toBeInstanceOf(InventoryVersionConflictError);
  });

  test("synchronous repository throws retain use-case mapping", async () => {
    const repositories: any = {
      products: {}, inventory: { findByProduct: () => ({ productId: "p1", locationId: null, quantity: 5, updatedAt: time }), updateWithVersion: () => { throw new StaleInventoryVersionError("p1"); } },
      stockMovements: { findByIdempotencyKey: () => null, append: vi.fn() }, stockLocations: {},
    };
    const context = buildInventoryApplicationContext({ repositories, unitOfWork: { run: (work) => work({ repositories: { inventoryRepositories: repositories } }) as any }, clock: { now: () => new Date(time) }, idGenerator: { newId: () => "m" }, logger: {} });
    await expect(createIncreaseInventoryUseCase(context).execute({ productId: "p1", quantity: 1, expectedVersion: time })).rejects.toBeInstanceOf(InventoryVersionConflictError);
  });

  test("PostgreSQL capability preserves asynchronous execution", async () => {
    const capability: any = { driver: "postgres", execution: "asynchronous", run: async (work: any) => work({ repositories: { inventoryRepositories: {} } }) };
    const context = createInventoryApplicationContextForDb({} as any, "postgres", capability);
    expect(context.unitOfWork.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("explicit driver and capability mismatch is rejected", () => {
    const capability: any = { driver: "postgres", execution: "asynchronous", run: vi.fn() };
    expect(() => createInventoryApplicationContextForDb({} as any, "sqlite", capability)).toThrow("INVENTORY_TRANSACTION_DRIVER_MISMATCH:sqlite:postgres");
  });
});
