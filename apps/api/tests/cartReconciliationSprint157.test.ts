import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-157-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";

let app: import("express").Express;
let db: any;
let schema: any;
let createProduct: any;
let categoryId: string;

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  schema = await import("../src/db/schema");
  createProduct = (await import("../src/services/products")).createProduct;
  categoryId = (await (await import("../src/services/categories")).createCategory(db, { name: "Sprint 157", displayOrder: 0, isActive: true })).id;
}, 30_000);

async function product(suffix: string, overrides: Record<string, unknown> = {}) {
  return createProduct(db, { sku: `S157-${suffix}`, title: `Canonical ${suffix}`, wooProductName: `Web ${suffix}`, slug: `s157-${suffix}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId, priceEur: 120, wooListingPriceEur: 100, priceUsd: 130, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false, ...overrides });
}

describe("Sprint 157 public cart reconciliation", () => {
  it("returns bounded, customer-safe current data in first-occurrence order", async () => {
    const first = await product("first");
    const second = await product("second", { wooListingPriceEur: 80, allowCashOnDelivery: false });
    const response = await request(app).post("/api/public/products/reconcile").send({ items: [
      { productId: second.id, quantity: 1 }, { productId: first.id, quantity: 1 }, { productId: second.id, quantity: 1 },
    ] });
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: any) => item.productId)).toEqual([second.id, first.id]);
    expect(response.body.items[0]).toEqual({ productId: second.id, availability: "available", slug: second.slug, title: "Web second", priceEur: 80, priceUsd: 130, productType: ProductType.UniqueItem, allowCashOnDelivery: false });
    for (const item of response.body.items) {
      expect(item).not.toHaveProperty("stockQuantity");
      expect(item).not.toHaveProperty("status");
      expect(item).not.toHaveProperty("sku");
      expect(item).not.toHaveProperty("purchaseCost");
    }
  });

  it("collapses hidden states and missing IDs while distinguishing exhausted stock", async () => {
    const draft = await product("draft", { status: ProductStatus.Draft });
    const paused = await product("paused", { salePausedAt: new Date().toISOString() });
    const sold = await product("sold", { status: ProductStatus.Sold, stockQuantity: 0 });
    const empty = await product("empty", { stockQuantity: 0 });
    const response = await request(app).post("/api/public/products/reconcile").send({ items: [draft, paused, sold, empty].map((p) => ({ productId: p.id, quantity: 1 })).concat([{ productId: "missing-157", quantity: 1 }]) });
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([
      { productId: draft.id, availability: "unavailable", reason: "unavailable" },
      { productId: paused.id, availability: "unavailable", reason: "unavailable" },
      { productId: sold.id, availability: "unavailable", reason: "unavailable" },
      { productId: empty.id, availability: "unavailable", reason: "out_of_stock" },
      { productId: "missing-157", availability: "unavailable", reason: "unavailable" },
    ]);
  });

  it("rejects malformed and oversized requests", async () => {
    expect((await request(app).post("/api/public/products/reconcile").send({ items: [] })).status).toBe(400);
    expect((await request(app).post("/api/public/products/reconcile").send({ items: Array.from({ length: 21 }, (_, i) => ({ productId: `p-${i}`, quantity: 1 })) })).status).toBe(400);
    expect((await request(app).post("/api/public/products/reconcile").send({ items: [{ productId: "p", quantity: 2 }] })).status).toBe(400);
  });

  it.each([[125, 100], [75, 100]])("rejects a COD subtotal changed to %s without side effects", async (currentPrice, reviewedSubtotal) => {
    const p = await product(`guard-${currentPrice}`);
    await db.update(schema.products).set({ wooListingPriceEur: currentPrice }).where(eq(schema.products.id, p.id));
    const orderDraftId = `s157-guard-${currentPrice}`;
    const address = { fullName: "Fresh Buyer", line1: "1 Test St", city: "Sofia", postalCode: "1000", country: "BG" };
    const response = await request(app).post("/api/orders/cod").set("X-Forwarded-For", `10.0.157.${currentPrice}`).send({ orderDraftId, guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, items: [{ productId: p.id, quantity: 1 }], subtotalAmount: reviewedSubtotal });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "CHECKOUT_PRICE_CHANGED" });
    expect(await db.select().from(schema.orders).where(eq(schema.orders.orderDraftId, orderDraftId))).toHaveLength(0);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].stockQuantity).toBe(1);
  });
});
