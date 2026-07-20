import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { createInventoryRepositoryBundleForDb } from "../src/repositories/inventory/factory";
import { createPurchaseApplicationContextForDb } from "../src/services/purchaseApplicationContextForDb";
import { createPurchaseUseCase, receivePurchaseUseCase } from "../src/application/purchase";
import { increaseInventoryInTransactionUseCase } from "../src/application/inventory";

const time = "2026-01-01T00:00:00.000Z";

async function harness() {
  const db = createTestDb();
  const inventory = createInventoryRepositoryBundleForDb(db, "sqlite");
  await inventory.products.create({
    id: "product-1", sku: "PURCHASE-1", title: "Purchase item", slug: "purchase-item",
    type: ProductType.UniqueItem, status: ProductStatus.Draft, priceEur: 10,
    stockQuantity: 3, purchaseCurrency: "EUR", createdAt: time, updatedAt: time,
  });
  const context = createPurchaseApplicationContextForDb({ db, driver: "sqlite" });
  const purchase = await createPurchaseUseCase(context).execute({
    lines: [{ productId: "product-1", titleSnapshot: "Purchase item", quantity: 2, unitPurchaseCost: 4 }],
  });
  const input = { purchaseId: purchase.id, idempotencyKey: "receipt-1", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] };
  return { context, inventory, purchase, input };
}

describe("Sprint 35F purchase receipt Inventory runtime", () => {
  test("successful receipt updates Inventory and records one movement", async () => {
    const { context, inventory, input } = await harness();
    const result = await receivePurchaseUseCase(context).execute(input);
    expect(result.purchase.status).toBe("Received");
    expect((await inventory.inventory.findByProduct("product-1"))?.quantity).toBe(5);
    expect(await inventory.stockMovements.listByProduct("product-1")).toHaveLength(1);
  });

  test("duplicate receipt does not duplicate Inventory mutation", async () => {
    const { context, inventory, input } = await harness();
    await receivePurchaseUseCase(context).execute(input);
    expect((await receivePurchaseUseCase(context).execute(input)).replayed).toBe(true);
    expect((await inventory.inventory.findByProduct("product-1"))?.quantity).toBe(5);
    expect(await inventory.stockMovements.listByProduct("product-1")).toHaveLength(1);
  });

  test("SQLite transaction callback remains synchronous", async () => {
    const { context, input } = await harness();
    await expect(receivePurchaseUseCase(context).execute(input)).resolves.toBeTruthy();
  });

  test("purchase receipt does not access general UnitOfWork Inventory repositories", async () => {
    const { context, input } = await harness();
    const unitOfWork = {
      run: <T>(work: Parameters<typeof context.unitOfWork.run<T>>[0]) =>
        context.unitOfWork.run(({ repositories }) =>
          work({
            repositories: new Proxy(repositories, {
              get(target, property, receiver) {
                if (property === "inventoryRepositories")
                  throw new Error("GENERAL_UOW_INVENTORY_ACCESSED");
                return Reflect.get(target, property, receiver);
              },
            }),
          }),
        ),
    };
    await expect(
      receivePurchaseUseCase({ ...context, unitOfWork }).execute(input),
    ).resolves.toMatchObject({ purchase: { status: "Received" } });
  });

  test("Inventory failure rolls back and preserves the purchase rejection", async () => {
    const { context, inventory, purchase, input } = await harness();
    await inventory.stockMovements.append({
      id: "collision", productId: "product-1", type: "PurchaseReceipt",
      quantityDelta: 1, stockBefore: 3, stockAfter: 4, orderId: null,
      orderItemId: null, note: null, idempotencyKey: "seed", createdAt: time, updatedAt: time,
    });
    const failingContext = { ...context, idGenerator: { newId: () => "collision" } };
    await expect(receivePurchaseUseCase(failingContext).execute(input)).rejects.toBeTruthy();
    expect((await inventory.inventory.findByProduct("product-1"))?.quantity).toBe(3);
    expect(await context.purchaseReceiptRepository.findByIdempotencyKey("receipt-1")).toBeNull();
    expect((await context.purchaseRepository.findById(purchase.id))?.status).toBe("Draft");
  });

  test("PostgreSQL-style repository execution remains asynchronous", async () => {
    const repositories: any = {
      inventory: {
        findByProduct: vi.fn().mockResolvedValue({ productId: "product-1", locationId: null, quantity: 3, updatedAt: time }),
        updateWithVersion: vi.fn().mockResolvedValue({ productId: "product-1", locationId: null, quantity: 5, updatedAt: time }),
      },
      stockMovements: {
        findByIdempotencyKey: vi.fn().mockResolvedValue(null),
        append: vi.fn().mockResolvedValue({ id: "movement", productId: "product-1", type: "PurchaseReceipt", quantityDelta: 2, stockBefore: 3, stockAfter: 5, orderId: null, orderItemId: null, note: null, idempotencyKey: "key", createdAt: time, updatedAt: time }),
      },
    };
    const execution = increaseInventoryInTransactionUseCase(
      { clock: { now: () => new Date(time) }, idGenerator: { newId: () => "movement" } },
      repositories,
      { productId: "product-1", quantity: 2, idempotencyKey: "key" },
    );
    expect(execution).toBeInstanceOf(Promise);
    await expect(execution).resolves.toMatchObject({ inventory: { quantity: 5 } });
  });

  test("migrated path has no direct Inventory repository mutation", () => {
    const source = readFileSync(new URL("../src/application/purchase/useCases.ts", import.meta.url), "utf8");
    const receive = source.slice(source.indexOf("export const receivePurchaseUseCase"));
    expect(receive).not.toMatch(/inventoryRepositories\.(inventory|stockMovements)\.(updateWithVersion|append)/);
    expect(receive).toContain("inventoryReceiptMutation");
  });
});
