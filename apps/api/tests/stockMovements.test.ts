import { PriceCurrency, ProductStatus, ProductType, StockMovementType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import {
  createStockMovement,
  getStockMovementById,
  listStockMovements,
  listStockMovementsByProduct,
} from "../src/services/stockMovements";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import { createStockMovementSchema, stockMovementListQuerySchema } from "../src/validation/stockMovement";
import { createTestDb } from "./testDb";

describe("stock movement service", () => {
  let db: ReturnType<typeof createTestDb>;
  let productId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Inventory", displayOrder: 0, isActive: true });
    const product = await createProduct(db, {
      sku: "SKU-STOCK-001",
      title: "Inventory Item",
      type: ProductType.LotItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
      stockQuantity: 5,
    });
    productId = product.id;
  });

  function movementInput(overrides: Record<string, unknown> = {}) {
    return createStockMovementSchema.parse({
      productId,
      type: StockMovementType.Purchase,
      quantity: 3,
      unitCost: 50,
      currency: PriceCurrency.Eur,
      ...overrides,
    });
  }

  it("creates an increase movement and updates product stock", async () => {
    const movement = await createStockMovement(db, movementInput());
    const product = await getProductById(db, productId);

    expect(movement.previousStock).toBe(5);
    expect(movement.newStock).toBe(8);
    expect(movement.quantity).toBe(3);
    expect(product.stockQuantity).toBe(8);
  });

  it("creates a decrease movement and updates product stock", async () => {
    const movement = await createStockMovement(
      db,
      movementInput({ type: StockMovementType.ManualDecrease, quantity: 2 }),
    );
    const product = await getProductById(db, productId);

    expect(movement.previousStock).toBe(5);
    expect(movement.newStock).toBe(3);
    expect(product.stockQuantity).toBe(3);
  });

  it("rejects negative stock and leaves product stock unchanged", async () => {
    await expect(
      createStockMovement(db, movementInput({ type: StockMovementType.Sale, quantity: 99 })),
    ).rejects.toBeInstanceOf(BadRequestError);

    const product = await getProductById(db, productId);
    expect(product.stockQuantity).toBe(5);
  });

  it("rejects invalid quantity", () => {
    const result = createStockMovementSchema.safeParse({
      productId,
      type: StockMovementType.Purchase,
      quantity: 0,
    });
    expect(result.success).toBe(false);
  });

  it("stores internally consistent previous and new stock values", async () => {
    const increase = await createStockMovement(db, movementInput({ quantity: 4 }));
    expect(increase.newStock - increase.previousStock).toBe(increase.quantity);

    const decrease = await createStockMovement(
      db,
      movementInput({ type: StockMovementType.ReturnOut, quantity: 2 }),
    );
    expect(decrease.previousStock - decrease.newStock).toBe(decrease.quantity);
  });

  it("supports correction movements by setting stock to a safe target", async () => {
    const movement = await createStockMovement(
      db,
      movementInput({ type: StockMovementType.Correction, quantity: 1, newStock: 12 }),
    );
    const product = await getProductById(db, productId);

    expect(movement.previousStock).toBe(5);
    expect(movement.newStock).toBe(12);
    expect(movement.quantity).toBe(7);
    expect(product.stockQuantity).toBe(12);
  });

  it("gets movement by ID", async () => {
    const movement = await createStockMovement(db, movementInput());
    await expect(getStockMovementById(db, movement.id)).resolves.toMatchObject({ id: movement.id });
  });

  it("lists by product, paginates, filters by type, and filters by reference", async () => {
    const first = await createStockMovement(
      db,
      movementInput({ referenceType: "order", referenceId: "order-1" }),
    );
    await createStockMovement(db, movementInput({ type: StockMovementType.ManualIncrease, quantity: 1 }));

    const byProduct = await listStockMovementsByProduct(
      db,
      productId,
      stockMovementListQuerySchema.parse({ page: 1, pageSize: 10 }),
    );
    expect(byProduct.data).toHaveLength(2);

    const paged = await listStockMovements(db, stockMovementListQuerySchema.parse({ page: 1, pageSize: 1 }));
    expect(paged.data).toHaveLength(1);
    expect(paged.pagination.total).toBe(2);

    const byType = await listStockMovements(
      db,
      stockMovementListQuerySchema.parse({ type: StockMovementType.Purchase }),
    );
    expect(byType.data.map((movement) => movement.id)).toEqual([first.id]);

    const byReference = await listStockMovements(
      db,
      stockMovementListQuerySchema.parse({ referenceType: "order", referenceId: "order-1" }),
    );
    expect(byReference.data.map((movement) => movement.id)).toEqual([first.id]);
  });

  it("rejects missing products", async () => {
    await expect(createStockMovement(db, movementInput({ productId: "missing" }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("keeps transaction safety when movement creation fails", async () => {
    await expect(
      createStockMovement(db, movementInput({ type: StockMovementType.ManualDecrease, quantity: 999 })),
    ).rejects.toBeInstanceOf(BadRequestError);

    const product = await getProductById(db, productId);
    const list = await listStockMovements(db, stockMovementListQuerySchema.parse({ productId }));
    expect(product.stockQuantity).toBe(5);
    expect(list.data).toHaveLength(0);
  });
});
