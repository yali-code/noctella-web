import { ProductStatus, ProductType, StockMovementType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import { BadRequestError } from "../src/services/errors";
import { createManualStockAdjustment, listStockMovements } from "../src/services/stockMovements";
import { manualStockAdjustmentSchema } from "../src/validation/stockMovement";
import { createTestDb } from "./testDb";

describe("stock movement service", () => {
  let db: ReturnType<typeof createTestDb>;
  let productId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Objects", displayOrder: 0, isActive: true });
    const product = await createProduct(db, {
      sku: "SKU-STOCK-001",
      title: "Inventory Object",
      slug: "inventory-object",
      type: ProductType.LotItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 500,
      stockQuantity: 3,
    });
    productId = product.id;
  });

  it("creates manual stock adjustments and ledger entries", async () => {
    const movement = await createManualStockAdjustment(
      db,
      manualStockAdjustmentSchema.parse({ productId, quantityDelta: -1, note: "Cycle count" }),
    );

    expect(movement).toMatchObject({
      productId,
      type: StockMovementType.ManualAdjustment,
      quantityDelta: -1,
      stockBefore: 3,
      stockAfter: 2,
      note: "Cycle count",
    });
    await expect(getProductById(db, productId)).resolves.toMatchObject({ stockQuantity: 2 });
  });

  it("is idempotent by key", async () => {
    const input = manualStockAdjustmentSchema.parse({ productId, quantityDelta: 2, idempotencyKey: "stock-key-1" });
    const first = await createManualStockAdjustment(db, input);
    const second = await createManualStockAdjustment(db, input);

    expect(second.id).toBe(first.id);
    await expect(getProductById(db, productId)).resolves.toMatchObject({ stockQuantity: 5 });
  });

  it("rejects movements that would create negative stock", async () => {
    await expect(
      createManualStockAdjustment(db, manualStockAdjustmentSchema.parse({ productId, quantityDelta: -4 })),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(getProductById(db, productId)).resolves.toMatchObject({ stockQuantity: 3 });
  });

  it("lists movement timeline by product", async () => {
    await createManualStockAdjustment(db, manualStockAdjustmentSchema.parse({ productId, quantityDelta: 1 }));
    const result = await listStockMovements(db, { productId, page: 1, pageSize: 20 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].productId).toBe(productId);
  });
});
