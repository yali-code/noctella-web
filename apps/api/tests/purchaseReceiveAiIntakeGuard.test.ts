import { describe, expect, it } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { aiProductIntakes } from "../src/db/schema";
import { createInventoryRepositoryBundleForDb } from "../src/repositories/inventory/factory";
import { createPurchaseApplicationContextForDb } from "../src/services/purchaseApplicationContextForDb";
import { createPurchaseUseCase, receivePurchaseUseCase } from "../src/application/purchase";

const t = "2026-01-01T00:00:00.000Z";

async function harness() {
  const db = createTestDb();
  const inventory = createInventoryRepositoryBundleForDb(db, "sqlite");
  const context = createPurchaseApplicationContextForDb({ db, driver: "sqlite" });
  return { db, inventory, context };
}

async function seedProduct(inventory: any, id: string, stockQuantity = 3) {
  await inventory.products.create({
    id, sku: `SKU-${id}`, title: `Product ${id}`, slug: `product-${id}`,
    type: ProductType.UniqueItem, status: ProductStatus.Draft, priceEur: 10,
    stockQuantity, purchaseCurrency: "EUR", createdAt: t, updatedAt: t,
  });
}

/** Owner-approved rule (D1, 2 Nov 2026): a result product of an ai_product_intakes row - any status. */
async function markAsAiIntakeResultProduct(db: any, productId: string) {
  await db.insert(aiProductIntakes).values({
    id: `intake-${productId}`,
    status: "applied",
    createdByAdminUserId: "admin-1",
    resultProductId: productId,
    createdAt: t,
    updatedAt: t,
  });
}

describe("PHASE-1A purchase Receive guard for AI-intake products", () => {
  it("rejects Receive when the single line's product has an AI-intake result row", async () => {
    const { db, inventory, context } = await harness();
    await seedProduct(inventory, "ai-product-1");
    await markAsAiIntakeResultProduct(db, "ai-product-1");
    const purchase = await createPurchaseUseCase(context).execute({
      lines: [{ productId: "ai-product-1", titleSnapshot: "AI item", quantity: 2, unitPurchaseCost: 4 }],
    });
    const input = { purchaseId: purchase.id, idempotencyKey: "receipt-ai-1", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] };

    await expect(receivePurchaseUseCase(context).execute(input)).rejects.toMatchObject({ code: "purchase_receive_not_allowed" });

    expect(await context.purchaseReceiptRepository.findByIdempotencyKey("receipt-ai-1")).toBeNull();
    expect((await context.purchaseRepository.findById(purchase.id))?.status).toBe("Draft");
    expect(await inventory.stockMovements.listByProduct("ai-product-1")).toHaveLength(0);
  });

  it("rejects the WHOLE command when only one of several lines is an AI-intake product (mixed lines) - no partial receipt", async () => {
    const { db, inventory, context } = await harness();
    await seedProduct(inventory, "ai-product-2");
    await seedProduct(inventory, "regular-product-1");
    await markAsAiIntakeResultProduct(db, "ai-product-2");
    const purchase = await createPurchaseUseCase(context).execute({
      lines: [
        { productId: "ai-product-2", titleSnapshot: "AI item", quantity: 1, unitPurchaseCost: 4 },
        { productId: "regular-product-1", titleSnapshot: "Regular item", quantity: 1, unitPurchaseCost: 4 },
      ],
    });
    const input = {
      purchaseId: purchase.id,
      idempotencyKey: "receipt-mixed-1",
      lines: [
        { purchaseLineId: purchase.lines[0].id, quantityReceived: 1 },
        { purchaseLineId: purchase.lines[1].id, quantityReceived: 1 },
      ],
    };

    await expect(receivePurchaseUseCase(context).execute(input)).rejects.toMatchObject({ code: "purchase_receive_not_allowed" });

    expect(await context.purchaseReceiptRepository.findByIdempotencyKey("receipt-mixed-1")).toBeNull();
    expect((await context.purchaseRepository.findById(purchase.id))?.status).toBe("Draft");
    expect(await inventory.stockMovements.listByProduct("ai-product-2")).toHaveLength(0);
    expect(await inventory.stockMovements.listByProduct("regular-product-1")).toHaveLength(0);
  });

  it("allows Receive for a product without an AI-intake row (regression)", async () => {
    const { inventory, context } = await harness();
    await seedProduct(inventory, "regular-product-2");
    const purchase = await createPurchaseUseCase(context).execute({
      lines: [{ productId: "regular-product-2", titleSnapshot: "Regular item", quantity: 2, unitPurchaseCost: 4 }],
    });
    const input = { purchaseId: purchase.id, idempotencyKey: "receipt-regular-1", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] };

    const result = await receivePurchaseUseCase(context).execute(input);

    expect(result.purchase.status).toBe("Received");
    expect(await inventory.stockMovements.listByProduct("regular-product-2")).toHaveLength(1);
  });

  it("a line without a productId is unaffected by the guard", async () => {
    const { context } = await harness();
    const purchase = await createPurchaseUseCase(context).execute({
      lines: [{ productId: null, titleSnapshot: "No-product line", quantity: 1, unitPurchaseCost: 2 }],
    });
    const input = { purchaseId: purchase.id, idempotencyKey: "receipt-noproduct-1", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 1 }] };

    const result = await receivePurchaseUseCase(context).execute(input);

    expect(result.purchase.status).toBe("Received");
  });

  it("an idempotent replay of a pre-existing receipt still returns replayed: true, even if the product later becomes an AI-intake result", async () => {
    const { db, inventory, context } = await harness();
    await seedProduct(inventory, "ai-product-3");
    const purchase = await createPurchaseUseCase(context).execute({
      lines: [{ productId: "ai-product-3", titleSnapshot: "AI item", quantity: 1, unitPurchaseCost: 4 }],
    });
    const input = { purchaseId: purchase.id, idempotencyKey: "receipt-replay-1", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 1 }] };

    // Real receipt first, while the product is still a regular (non-AI-intake) product.
    const first = await receivePurchaseUseCase(context).execute(input);
    expect(first.purchase.status).toBe("Received");

    // Only afterwards does the product become an AI-intake result product.
    await markAsAiIntakeResultProduct(db, "ai-product-3");

    const replay = await receivePurchaseUseCase(context).execute(input);
    expect(replay.replayed).toBe(true);
  });
});
