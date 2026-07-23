import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb } from "./testDb";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";
import { cancelPurchase, createPurchase, createSupplier, executePurchaseCommand, markOrdered, receivePurchase } from "../src/services/erpPurchasingBridge";
import { ProductStatus, ProductType, SupplierType } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import * as schema from "../src/db/schema";
import { eq } from "drizzle-orm";

/**
 * Sprint 57B: proves the cancel-purchase safety correction (routing the live command
 * through the existing, tested cancelPurchaseUseCase instead of an unguarded direct
 * update) and the new mark-ordered command. Bridge-level (direct function calls),
 * matching this codebase's existing purchasing test convention.
 */
describe("purchase cancel safety and mark-ordered (Sprint 57B)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId = "";
  const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, idempotencyKey: key, payload });

  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Purchasing 57B", displayOrder: 0, isActive: true })).id;
  });

  async function seedPurchase(overrides: any = {}) {
    const product = await createProduct(db, { sku: `SKU-${Math.random()}`, title: "Item", slug: `item-${Math.random()}`, type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, stockQuantity: 0, priceEur: 100, purchaseCurrency: "EUR" } as any);
    const supplier: any = await createSupplier(db, { name: `Supplier ${Math.random()}`, supplierType: SupplierType.Dealer });
    const purchase: any = await createPurchase(db, { supplierId: supplier.id, sourceType: "Other", lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 2, unitPurchaseCost: 10 }], ...overrides });
    return { product, supplier, purchase };
  }

  it("A: a Draft purchase can be cancelled", async () => {
    const { purchase } = await seedPurchase();
    const out = await cancelPurchase(db, purchase.id);
    expect(out.status).toBe("Cancelled");
  });

  it("B: a Received purchase cannot be cancelled - rejected with no status or inventory change", async () => {
    const { purchase, product } = await seedPurchase();
    await receivePurchase(db, purchase.id, { idempotencyKey: "recv-b", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] });
    const [before] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    await expect(cancelPurchase(db, purchase.id)).rejects.toBeInstanceOf(BadRequestError);
    const after = await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchase.id));
    expect(after[0].status).toBe("Received");
    const [invAfter] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(invAfter.stockQuantity).toBe(before.stockQuantity);
  });

  it("C: a PartiallyReceived purchase cannot be cancelled - rejected with no status or inventory change", async () => {
    const { purchase, product } = await seedPurchase();
    await receivePurchase(db, purchase.id, { idempotencyKey: "recv-c", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 1 }] });
    const [before] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    await expect(cancelPurchase(db, purchase.id)).rejects.toBeInstanceOf(BadRequestError);
    const after = await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchase.id));
    expect(after[0].status).toBe("PartiallyReceived");
    const [invAfter] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(invAfter.stockQuantity).toBe(before.stockQuantity);
  });

  it("D: repeated cancellation of an already-Cancelled purchase remains safe (idempotent in effect, no error)", async () => {
    const { purchase } = await seedPurchase();
    await cancelPurchase(db, purchase.id);
    const again = await cancelPurchase(db, purchase.id);
    expect(again.status).toBe("Cancelled");
  });

  it("E: cancel is exposed through the ERP command envelope and produces a Completed command row", async () => {
    const { purchase } = await seedPurchase();
    const out: any = await executePurchaseCommand(db, "client", env({}, "cancel-e"), "CancelPurchase", purchase.id);
    expect(out.status).toBe("Cancelled");
    const [row]: any = await db.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "cancel-e"));
    expect(row.status).toBe("Completed");
  });

  it("F: cancel rejection for a Received purchase is marked Failed on the command row with a safe error code", async () => {
    const { purchase } = await seedPurchase();
    await receivePurchase(db, purchase.id, { idempotencyKey: "recv-f", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] });
    await expect(executePurchaseCommand(db, "client", env({}, "cancel-f"), "CancelPurchase", purchase.id)).rejects.toBeInstanceOf(BadRequestError);
    const [row]: any = await db.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "cancel-f"));
    expect(row.status).toBe("Failed");
    expect(row.safeErrorCode).toBe("BadRequestError");
  });

  it("G: a not-found purchase maps to NotFoundError, not a generic error", async () => {
    await expect(cancelPurchase(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("H: mark-ordered transitions a Draft purchase to Ordered", async () => {
    const { purchase } = await seedPurchase();
    const out = await markOrdered(db, purchase.id);
    expect(out.status).toBe("Ordered");
    expect(out.orderedAt).toBeTruthy();
  });

  it("I: mark-ordered rejects a purchase that is not Draft (invalid transition)", async () => {
    const { purchase } = await seedPurchase();
    await markOrdered(db, purchase.id);
    await expect(markOrdered(db, purchase.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("J: mark-ordered on a missing purchase maps to NotFoundError", async () => {
    await expect(markOrdered(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("K: mark-ordered command-envelope idempotency - same key+payload replays without re-executing", async () => {
    const { purchase } = await seedPurchase();
    const first: any = await executePurchaseCommand(db, "client", env({}, "order-k"), "MarkPurchaseOrdered", purchase.id);
    expect(first.status).toBe("Ordered");
    const replay: any = await executePurchaseCommand(db, "client", env({}, "order-k"), "MarkPurchaseOrdered", purchase.id);
    expect(replay.status).toBe("Completed");
    const rows = await db.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "order-k"));
    expect(rows).toHaveLength(1);
  });

  it("L: mark-ordered records an Ordered event in the purchase timeline", async () => {
    const { purchase } = await seedPurchase();
    await markOrdered(db, purchase.id);
    const events = await db.select().from(schema.purchaseEvents).where(eq(schema.purchaseEvents.purchaseId, purchase.id));
    expect(events.some((e) => e.eventType === "Ordered")).toBe(true);
  });
});
