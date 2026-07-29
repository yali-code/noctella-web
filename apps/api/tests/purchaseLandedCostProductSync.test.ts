import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { CarrierCode, LandedCostAllocationMethod, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType, ShipmentStatus } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { allocatePurchaseCosts, createPurchase, getPurchase, receivePurchase } from "../src/services/erpPurchasingBridge";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { completeSale } from "../src/services/shipments";
import { issueInvoice, listInvoices } from "../src/services/erpSalesFinanceBridge";
import { upsertCompanyProfile } from "../src/services/companyProfile";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }) as any; }

async function seedProduct(db: any, sku: string, purchaseCost: number | null = null) {
  const cat = await createCategory(db, { name: `Cat-${sku}`, displayOrder: 0, isActive: true });
  return createProduct(db, { sku, title: sku, slug: sku.toLowerCase(), type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 500, purchaseCost: purchaseCost ?? undefined, stockQuantity: 0, images: [] });
}

describe("Sprint 79 landed-cost -> product.purchaseCost synchronization", () => {
  let db: any;
  beforeEach(() => { db = memoryDb(); });

  it("allocating landed costs for a quantity-1 line with an unset purchase cost writes the allocated landed unit cost onto the product", async () => {
    const product = await seedProduct(db, "SKU-LC-1");
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 1, unitPurchaseCost: 100 }], shippingCost: 20, currency: "EUR" });
    await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const [updated] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(updated.purchaseCost).toBe(120);
  });

  it("receiving goods before any allocation exists does not invent a purchase cost (nothing to sync from yet)", async () => {
    // Note: allocatePurchaseCosts rejects once a purchase is fully Received ("Finalized received
    // allocation cannot be silently rewritten" - pre-existing, unrelated guard preserved as-is),
    // so for a single-line quantity-1 purchase the only achievable real sequence is
    // allocate-then-receive, exercised by the next test. This test only proves receipt alone
    // never fabricates a cost.
    const product = await seedProduct(db, "SKU-LC-2");
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 1, unitPurchaseCost: 80 }], shippingCost: 0, currency: "EUR" });
    const line = (await getPurchase(db, purchase.id)).lines[0];
    await receivePurchase(db, purchase.id, { idempotencyKey: "receive-1", lines: [{ purchaseLineId: line.id, quantityReceived: 1 }] });
    const [afterReceiveOnly] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(afterReceiveOnly.purchaseCost).toBeNull();
  });

  it("allocating then receiving syncs the cost once, and the post-receipt sync pass is a safe no-op that leaves it unchanged", async () => {
    const product = await seedProduct(db, "SKU-LC-2B");
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 1, unitPurchaseCost: 80 }], shippingCost: 0, currency: "EUR" });
    await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const [afterAllocate] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(afterAllocate.purchaseCost).toBe(80);
    const line = (await getPurchase(db, purchase.id)).lines[0];
    await receivePurchase(db, purchase.id, { idempotencyKey: "receive-2", lines: [{ purchaseLineId: line.id, quantityReceived: 1 }] });
    const [afterReceive] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(afterReceive.purchaseCost).toBe(80);
  });

  it("replaying the same receipt idempotency key does not multiply or drift the synced product cost", async () => {
    const product = await seedProduct(db, "SKU-LC-3");
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 1, unitPurchaseCost: 60 }], shippingCost: 10, currency: "EUR" });
    await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const line = (await getPurchase(db, purchase.id)).lines[0];
    await receivePurchase(db, purchase.id, { idempotencyKey: "replay-key", lines: [{ purchaseLineId: line.id, quantityReceived: 1 }] });
    await receivePurchase(db, purchase.id, { idempotencyKey: "replay-key", lines: [{ purchaseLineId: line.id, quantityReceived: 1 }] });
    const [after] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(after.purchaseCost).toBe(70);
  });

  it("quantity greater than 1 is deliberately left untouched (unresolved weighted-average/FIFO decision deferred)", async () => {
    const product = await seedProduct(db, "SKU-LC-4");
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item x2", quantity: 2, unitPurchaseCost: 40 }], shippingCost: 10, currency: "EUR" });
    await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const [after] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(after.purchaseCost).toBeNull();
  });

  it("does not silently overwrite a purchase cost already established by a different, unrelated purchase", async () => {
    const product = await seedProduct(db, "SKU-LC-5", 999);
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 1, unitPurchaseCost: 10 }], shippingCost: 0, currency: "EUR" });
    await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const [after] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(after.purchaseCost).toBe(999);
  });

  it("sale financials consume the synchronized product cost end to end via completeSale (item_cost/profit reflect the landed-cost sync, not a separately entered value)", async () => {
    await upsertCompanyProfile(db, { legalName: "Noctella Test Ltd.", registrationNumber: "T-LC", vatNumber: "TESTVATLC", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 });
    const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
    const cat = await createCategory(db, { name: "Cat-sale", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-LC-SALE", title: "Sale item", slug: "sku-lc-sale", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 200, stockQuantity: 1, images: [] });
    const purchase = await createPurchase(db, { lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 1, unitPurchaseCost: 33 }], shippingCost: 0, currency: "EUR" });
    await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const [synced] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(synced.purchaseCost).toBe(33);

    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "lc-sale-ref", status: PaymentStatus.Paid, amount: 200, currency: "EUR", idempotencyKey: "lc-sale-pay" });
    const order = await createOrder(db, { orderDraftId: "lc-sale-draft", guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "lc-sale-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 200, totalAmount: 200, items: [{ productId: product.id, quantity: 1 as const }] });
    const now = new Date().toISOString();
    await db.insert(schema.shipments).values({ id: "ship-lc-sale", orderId: order.id, carrierCode: CarrierCode.LocalPickup, status: ShipmentStatus.InTransit, shippingCost: 0, currency: "EUR", createdAt: now, updatedAt: now });
    const [draftInvoice] = (await listInvoices(db, { orderId: order.id })).items;
    await issueInvoice(db, (draftInvoice as any).id, {});
    await completeSale(db, order.id);
    const [financials] = await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId, order.id));
    expect(financials.itemCost).toBe(33);
  });
});
