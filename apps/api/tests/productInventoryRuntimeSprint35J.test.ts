import { readFileSync } from "node:fs";
import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.sqlite";
import { createCategory } from "../src/services/categories";
import { createProduct, updateProduct } from "../src/services/products";
import { createTestDb } from "./testDb";

describe("Sprint 35J product write Inventory runtime migration", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  const input = (overrides: Record<string, unknown> = {}) => ({
    sku: "LOT-35J", title: "Inventory Lot", type: ProductType.LotItem,
    status: ProductStatus.Draft, categoryId, priceEur: 10,
    customsWarning: false, isFeatured: false, allowMakeOffer: false,
    allowCashOnDelivery: false, showInArchiveAfterSale: false, ...overrides,
  });

  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "35J", displayOrder: 0, isActive: true })).id;
  });

  test("creation without quantity preserves default stock without a movement", async () => {
    const product = await createProduct(db, input());
    expect(product.stockQuantity).toBe(1);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
  });

  test("creation with quantity records Inventory through the approved runtime", async () => {
    const product = await createProduct(db, input({ stockQuantity: 4 }));
    const movements = await db.select().from(schema.stockMovements);
    expect(product.stockQuantity).toBe(4);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ productId: product.id, stockAfter: 4 });
  });

  test("metadata-only update creates no movement", async () => {
    const product = await createProduct(db, input());
    await updateProduct(db, product.id, { title: "Renamed" });
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
  });

  test("stock update records exactly one movement and duplicate target is a no-op", async () => {
    const product = await createProduct(db, input());
    await updateProduct(db, product.id, { stockQuantity: 5 });
    await updateProduct(db, product.id, { stockQuantity: 5 });
    const movements = await db.select().from(schema.stockMovements);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ productId: product.id, quantityDelta: 4, stockAfter: 5 });
  });

  test("product failure does not add an Inventory mutation", async () => {
    await createProduct(db, input({ stockQuantity: 3 }));
    await expect(createProduct(db, input({ stockQuantity: 4 }))).rejects.toThrow();
    expect(await db.select().from(schema.stockMovements)).toHaveLength(1);
  });

  test("Inventory failure rolls back product persistence and preserves the error", async () => {
    (db as any).$client.exec("CREATE TRIGGER fail_product_stock BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT, 'inventory failed'); END");
    await expect(createProduct(db, input({ stockQuantity: 3 }))).rejects.toThrow("inventory failed");
    expect(await db.select().from(schema.products).where(eq(schema.products.sku, "LOT-35J"))).toHaveLength(0);
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
  });

  test("migrated product paths contain no direct stock persistence", () => {
    const service = readFileSync(new URL("../src/services/products.ts", import.meta.url), "utf8");
    const useCases = readFileSync(new URL("../src/use-cases/product-write/useCases.ts", import.meta.url), "utf8");
    expect(service).toContain("createProductWithInventoryUseCase");
    expect(service).toContain("updateProductWithInventoryUseCase");
    const migrated = useCases.slice(useCases.indexOf("export function createProductWithInventoryUseCase"), useCases.indexOf("export async function createCategoryUseCase"));
    expect(migrated).not.toMatch(/stockQuantity\s*:/);
    expect(useCases).toContain("initializeInventoryInTransactionUseCase");
    expect(useCases).toContain("setInventoryQuantityInTransactionUseCase");
    const runtime = readFileSync(new URL("../src/services/inventoryApplicationContextForDb.ts", import.meta.url), "utf8");
    expect(runtime).toContain("SQLITE_ASYNC_TRANSACTION_CALLBACK_REJECTED");
    expect(runtime).toContain('execution: "asynchronous"');
  });
});
