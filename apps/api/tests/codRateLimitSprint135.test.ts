import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "sprint-135-rate-limit-state-secret";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";

let app: import("express").Express;
let db: any;
let schema: any;
let createProduct: any;
let categoryId: string;
const address = { fullName: "COD Buyer", line1: "1 Sofia Street", city: "Sofia", postalCode: "1000", country: "BG" };

beforeAll(async () => {
  app = (await import("../src/app")).default;
  db = (await import("../src/db/client")).db;
  schema = await import("../src/db/schema");
  createProduct = (await import("../src/services/products")).createProduct;
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "Sprint 135 Rate Limit", displayOrder: 0, isActive: true });
  categoryId = category.id;
});

let seq = 0;
async function product() {
  seq += 1;
  return createProduct(db, { sku: `RL-${seq}`, title: `Rate Limit Product ${seq}`, wooProductName: `Web Rate Limit ${seq}`, slug: `rate-limit-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId, priceEur: 50, wooListingPriceEur: 50, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false });
}

function intent(orderDraftId: string, productId: string) {
  return { orderDraftId, guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, items: [{ productId, quantity: 1 }] };
}

function postCod(clientIp: string, body: unknown) {
  return request(app).post("/api/orders/cod").set("X-Forwarded-For", clientIp).send(body);
}

describe("Sprint 135 COD order-creation rate limiting", () => {
  it("1. the first five attempts from the same effective client IP are not rejected by the limiter", async () => {
    const ip = "203.0.113.1";
    for (let i = 0; i < 5; i++) {
      const p = await product();
      const res = await postCod(ip, intent(`rl-first-five-${i}`, p.id));
      expect(res.status).not.toBe(429);
    }
  });

  it("2. the sixth attempt inside the same window from the same IP returns 429", async () => {
    const ip = "203.0.113.2";
    for (let i = 0; i < 5; i++) {
      const p = await product();
      const res = await postCod(ip, intent(`rl-sixth-warmup-${i}`, p.id));
      expect(res.status).not.toBe(429);
    }
    const p = await product();
    const sixth = await postCod(ip, intent("rl-sixth", p.id));
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: expect.any(String) });
  });

  it("3. failed-validation attempts still consume the same allowance (not skipped)", async () => {
    const ip = "203.0.113.3";
    // Five deliberately invalid requests (missing productId) - each still reaches the route and
    // must still count, since a malformed-request flood is exactly the abuse pattern this exists
    // to bound, not something the limiter should politely exempt.
    for (let i = 0; i < 5; i++) {
      const res = await postCod(ip, { orderDraftId: `rl-invalid-${i}`, guestEmail: "buyer@example.com", billingAddress: address, shippingAddress: address, items: [] });
      expect(res.status).toBe(400);
    }
    const p = await product();
    const sixth = await postCod(ip, intent("rl-invalid-sixth", p.id));
    expect(sixth.status).toBe(429);
  });

  it("4. a different effective client IP has its own independent allowance", async () => {
    const exhaustedIp = "203.0.113.4";
    for (let i = 0; i < 5; i++) {
      const p = await product();
      await postCod(exhaustedIp, intent(`rl-exhaust-${i}`, p.id));
    }
    expect((await postCod(exhaustedIp, intent("rl-exhaust-sixth", (await product()).id))).status).toBe(429);

    const freshIp = "203.0.113.5";
    const freshProduct = await product();
    const res = await postCod(freshIp, intent("rl-fresh-ip", freshProduct.id));
    expect(res.status).not.toBe(429);
  });

  it("5. an unrelated public route (shipping-options quote) is not affected by the COD limiter", async () => {
    const ip = "203.0.113.6";
    for (let i = 0; i < 5; i++) {
      const p = await product();
      await postCod(ip, intent(`rl-unrelated-warmup-${i}`, p.id));
    }
    expect((await postCod(ip, intent("rl-unrelated-exhausted", (await product()).id))).status).toBe(429);

    // The exact same (now COD-throttled) IP must still be able to call the unrelated quote route.
    const p = await product();
    const quote = await request(app).post("/api/orders/shipping-options").set("X-Forwarded-For", ip).send({ items: [{ productId: p.id, quantity: 1 }] });
    expect(quote.status).not.toBe(429);
  });

  it("6. existing COD idempotency/business behavior is unchanged beneath the limiter", async () => {
    const ip = "203.0.113.7";
    const p = await product();
    const first = await postCod(ip, intent("rl-idempotency", p.id));
    expect(first.status).toBe(201);
    const replay = await postCod(ip, intent("rl-idempotency", p.id));
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.orderDraftId, "rl-idempotency"));
    expect(orders).toHaveLength(1);
  });

  it("7. sets standard RateLimit-* headers and omits legacy X-RateLimit-* headers", async () => {
    const ip = "203.0.113.8";
    const p = await product();
    const res = await postCod(ip, intent("rl-headers", p.id));
    expect(res.headers).toHaveProperty("ratelimit-limit");
    expect(res.headers).not.toHaveProperty("x-ratelimit-limit");
  });
});
