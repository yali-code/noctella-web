import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-173-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";

let app: import("express").Express;
let db: any;
let schema: any;
let createProduct: any;
let categoryId: string;
let sequence = 0;

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  schema = await import("../src/db/schema");
  createProduct = (await import("../src/services/products")).createProduct;
  categoryId = (await (await import("../src/services/categories")).createCategory(db, {
    name: "Sprint 173",
    displayOrder: 0,
    isActive: true,
  })).id;
}, 60_000);

async function product(label: string, overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return createProduct(db, {
    sku: `S173-${sequence}`,
    title: `Canonical ${label}`,
    wooProductName: `Web ${label}`,
    slug: `s173-${sequence}`,
    type: ProductType.UniqueItem,
    status: ProductStatus.Published,
    categoryId,
    priceEur: 120,
    wooListingPriceEur: 100,
    priceUsd: 130,
    stockQuantity: 1,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: true,
    showInArchiveAfterSale: false,
    ...overrides,
  });
}

describe("Sprint 173 public Wishlist product resolution", () => {
  it("resolves an eligible product by ID even when it is outside catalog page one", async () => {
    const target = await product("outside-page-one");
    await db.update(schema.products).set({ createdAt: "2000-01-01T00:00:00.000Z" }).where(eq(schema.products.id, target.id));
    for (let index = 0; index < 100; index += 1) await product(`newer-${index}`);

    const firstPage = await request(app).get("/api/public/products?pageSize=100");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items.map((item: any) => item.id)).not.toContain(target.id);

    const response = await request(app).post("/api/public/products/resolve").send({ ids: [target.id] });
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: any) => item.id)).toEqual([target.id]);
  }, 30_000);

  it("trims IDs, suppresses duplicates, and preserves first-occurrence order", async () => {
    const first = await product("first");
    const second = await product("second");
    const response = await request(app).post("/api/public/products/resolve").send({
      ids: [` ${second.id} `, first.id, second.id],
    });
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: any) => item.id)).toEqual([second.id, first.id]);
  });

  it("silently omits every non-public state and missing IDs from mixed input", async () => {
    const eligible = await product("eligible");
    const draft = await product("draft", { status: ProductStatus.Draft });
    const approved = await product("approved", { status: ProductStatus.Approved });
    const reserved = await product("reserved", { status: ProductStatus.Reserved });
    const returned = await product("returned", { status: ProductStatus.Returned });
    const archived = await product("archived", { status: ProductStatus.Archived });
    const sold = await product("sold", { status: ProductStatus.Sold, stockQuantity: 0 });
    const paused = await product("paused", { salePausedAt: new Date().toISOString() });
    const response = await request(app).post("/api/public/products/resolve").send({
      ids: [draft.id, eligible.id, approved.id, reserved.id, returned.id, archived.id, sold.id, paused.id, "missing-173"],
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [expect.objectContaining({ id: eligible.id })] });
  });

  it("returns the existing customer-safe public product DTO", async () => {
    const eligible = await product("customer-safe", { purchaseCost: 42, internalNotes: "private" });
    const response = await request(app).post("/api/public/products/resolve").send({ ids: [eligible.id] });
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ id: eligible.id, title: "Web customer-safe", priceEur: 100 });
    for (const key of ["sku", "stockQuantity", "purchaseCost", "purchaseCurrency", "internalNotes", "erpReferenceId", "wooListingPriceEur"]) {
      expect(response.body.items[0]).not.toHaveProperty(key);
    }
  });

  it("accepts exactly 100 submitted IDs", async () => {
    const response = await request(app).post("/api/public/products/resolve").send({
      ids: Array.from({ length: 100 }, (_, index) => `missing-${index}`),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
  });

  it.each([
    ["empty input", { ids: [] }],
    ["missing ids", {}],
    ["non-array ids", { ids: "valid" }],
    ["non-string id", { ids: [1] }],
    ["blank id", { ids: ["   "] }],
    ["extra field", { ids: ["valid"], extra: true }],
    ["more than 100 ids", { ids: Array.from({ length: 101 }, (_, index) => `id-${index}`) }],
  ])("rejects %s", async (_label, body) => {
    expect((await request(app).post("/api/public/products/resolve").send(body)).status).toBe(400);
  });
});
