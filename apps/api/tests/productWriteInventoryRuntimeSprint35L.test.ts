import { readFileSync } from "node:fs";
import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, test } from "vitest";
import * as schema from "../src/db/schema.sqlite";
import { createCategory } from "../src/services/categories";
import { createProduct, updateProduct } from "../src/services/products";
import { createTestDb } from "./testDb";

describe("Sprint 35L complete Product Write Inventory runtime migration", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  const input = (overrides: Record<string, unknown> = {}) => ({
    sku: "LOT-35L", title: "Atomic Lot", type: ProductType.LotItem,
    status: ProductStatus.Draft, categoryId, priceEur: 10,
    customsWarning: false, isFeatured: false, allowMakeOffer: false,
    allowCashOnDelivery: false, showInArchiveAfterSale: false, ...overrides,
  });

  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "35L", displayOrder: 0, isActive: true })).id;
  });

  test("metadata and quantity update commit atomically", async () => {
    const product = await createProduct(db, input());
    const updated = await updateProduct(db, product.id, { title: "Atomic Rename", stockQuantity: 6 });
    expect(updated).toMatchObject({ title: "Atomic Rename", stockQuantity: 6 });
    expect(await db.select().from(schema.stockMovements)).toHaveLength(1);
  });

  test("Product Write failure leaves no Inventory mutation", async () => {
    const product = await createProduct(db, input());
    (db as any).$client.exec("CREATE TRIGGER fail_product_write BEFORE UPDATE ON products WHEN NEW.title = 'Blocked' BEGIN SELECT RAISE(ABORT, 'product write failed'); END");
    await expect(updateProduct(db, product.id, { title: "Blocked", stockQuantity: 6 })).rejects.toThrow("product write failed");
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
    expect((await updateProduct(db, product.id, {})).stockQuantity).toBe(1);
  });

  test("Inventory failure rolls back Product Write metadata", async () => {
    const product = await createProduct(db, input());
    (db as any).$client.exec("CREATE TRIGGER fail_inventory_write BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT, 'inventory failed'); END");
    await expect(updateProduct(db, product.id, { title: "Must Roll Back", stockQuantity: 6 })).rejects.toThrow("inventory failed");
    const unchanged = await updateProduct(db, product.id, {});
    expect(unchanged).toMatchObject({ title: "Atomic Lot", stockQuantity: 1 });
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
  });

  test("migrated paths use the Product Write capability instead of general UnitOfWork Inventory mutation", () => {
    const useCases = readFileSync(new URL("../src/use-cases/product-write/useCases.ts", import.meta.url), "utf8");
    const migrated = useCases.slice(useCases.indexOf("export function createProductWithInventoryUseCase"), useCases.indexOf("export async function createCategoryUseCase"));
    expect(migrated).toContain("repositories.productWriteRepositories.products.create");
    expect(migrated).toContain("repositories.productWriteRepositories.products.updateWithExpectedVersion");
    expect(migrated).not.toContain("repositories.inventoryRepositories.products");
    expect(migrated).not.toContain("UnitOfWork");
  });

  test("capability keeps SQLite synchronous and PostgreSQL asynchronous", () => {
    const capability = readFileSync(new URL("../src/services/productWriteTransactionCapabilityForDb.ts", import.meta.url), "utf8");
    expect(capability).toContain('execution: "synchronous"');
    expect(capability).toContain("SQLITE_ASYNC_PRODUCT_WRITE_TRANSACTION_CALLBACK_REJECTED");
    expect(capability).toContain('execution: "asynchronous"');
    expect(capability).toContain("db.transaction(async");
  });
});
