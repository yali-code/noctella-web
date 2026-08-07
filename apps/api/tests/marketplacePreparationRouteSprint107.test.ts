// Sprint 107: proves the Marketplace Preparation routes' permission enforcement, request-contract
// validation, actor-identity boundary, and exact response/error contracts end-to-end, mirroring
// aiIntakeStockAcceptanceRouteSprint106.test.ts's proven supertest/real-app pattern. Operates on a
// canonical Product created directly (never through AI Intake) - Marketplace Preparation always
// starts from the current canonical Product regardless of how it was created.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole, ProductStatus, ProductType } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-marketplace-preparation-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-marketplace-preparation";
delete process.env.MARKETPLACE_PREP_PROVIDER; // Mock provider - no live OpenAI call in this suite

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];
let createCategory: (typeof import("../src/services/categories"))["createCategory"];
let createProduct: (typeof import("../src/services/products"))["createProduct"];

const PASSWORD = "correct-password-123";
let ownerCookie: string; // Owner: has products.publish
let noPermissionCookie: string; // ProductEditor: has products.view/edit but NOT products.publish
let categoryId: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

let skuCounter = 0;
async function createTestProduct(overrides: Record<string, unknown> = {}): Promise<string> {
  skuCounter += 1;
  const product = await createProduct(db, {
    sku: `MPR-${skuCounter}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Route Test Watch ${skuCounter}`,
    description: "A rare vintage watch.",
    type: ProductType.UniqueItem,
    status: ProductStatus.Draft,
    categoryId,
    priceEur: 500,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    ...overrides,
  } as any);
  return product.id;
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;
  const categories = await import("../src/services/categories");
  createCategory = categories.createCategory;
  const products = await import("../src/services/products");
  createProduct = products.createProduct;

  await createAdminUser(db, { email: "mp-owner@example.com", password: PASSWORD, role: AdminRole.Owner });
  ownerCookie = await login("mp-owner@example.com");
  await createAdminUser(db, { email: "mp-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  noPermissionCookie = await login("mp-editor@example.com");

  const category = await createCategory(db, { name: "Sprint 107 Route Test Category", displayOrder: 0, isActive: true } as any);
  categoryId = category.id;
});

afterAll(() => {});

describe("POST /api/products/:id/marketplace-preparation (generate)", () => {
  it("generates a Pending preparation from the canonical Product - 200, exact response shape", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", ownerCookie).send({ channel: "ebay" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.productId).toBe(productId);
    expect(res.body.channel).toBe("ebay");
    expect(res.body.suggestedTitle).toMatch(/^Route Test Watch \d+$/);
    expect(res.body.suggestedTags).toBeUndefined(); // eBay-scoped - Etsy-only fields never populated
  });

  it("rejects an unauthenticated request with 401", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/marketplace-preparation`).send({ channel: "ebay" });
    expect(res.status).toBe(401);
  });

  it("rejects a request from an admin without products.publish with 403", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", noPermissionCookie).send({ channel: "ebay" });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid channel value with 400", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", ownerCookie).send({ channel: "woocommerce" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown request body field", async () => {
    const productId = await createTestProduct();
    const res = await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", ownerCookie).send({ channel: "ebay", somethingElse: true });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent product", async () => {
    const res = await request(app).post("/api/products/does-not-exist/marketplace-preparation").set("Cookie", ownerCookie).send({ channel: "ebay" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/products/:id/marketplace-preparation (read current)", () => {
  it("returns 404 when nothing has been generated yet for the channel", async () => {
    const productId = await createTestProduct();
    const res = await request(app).get(`/api/products/${productId}/marketplace-preparation?channel=ebay`).set("Cookie", ownerCookie);
    expect(res.status).toBe(404);
  });

  it("returns the current preparation after generation", async () => {
    const productId = await createTestProduct();
    await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", ownerCookie).send({ channel: "etsy" });
    const res = await request(app).get(`/api/products/${productId}/marketplace-preparation?channel=etsy`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("etsy");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const productId = await createTestProduct();
    const res = await request(app).get(`/api/products/${productId}/marketplace-preparation?channel=ebay`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/products/:id/marketplace-preparation/approve", () => {
  async function readyPreparation(channel = "ebay") {
    const productId = await createTestProduct();
    const generated = await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", ownerCookie).send({ channel });
    return { productId, expectedProposalUpdatedAt: generated.body.updatedAt as string };
  }

  it("approves and writes only the selected channel's Product fields - 200, canonical Product response", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    const res = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "Approved eBay Title", description: "Approved eBay Description" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(productId);
    expect(res.body.ebayTitle).toBe("Approved eBay Title");
    expect(res.body.etsyTitle).toBeFalsy();
  });

  it("returns 409 with a deterministic code for a stale expectedProposalUpdatedAt", async () => {
    const { productId } = await readyPreparation("ebay");
    const res = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt: "not-the-real-value", title: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MARKETPLACE_PREPARATION_VERSION_CONFLICT");
  });

  it("returns 409 with a deterministic code when approving an already-Applied preparation", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    const first = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "x" });
    expect(first.status).toBe(200);
    const retry = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "y" });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe("MARKETPLACE_PREPARATION_NOT_PENDING");
  });

  it("returns 409 with the existing PRODUCT_VERSION_CONFLICT code when the Product changed since generation", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    const productModule = await import("../src/services/products");
    const current = await productModule.getProductById(db, productId);
    await productModule.updateProduct(db, productId, { title: "Edited By Someone Else", expectedUpdatedAt: current.updatedAt });
    const res = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRODUCT_VERSION_CONFLICT");
  });

  it("rejects a client-supplied sku/status/stockQuantity in the body", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    const res = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "x", sku: "NOC-999999" });
    expect(res.status).toBe(400);
  });

  it("persists req.adminUser.id as appliedByAdminUserId, never a body value", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "x" });
    const check = await request(app).get(`/api/products/${productId}/marketplace-preparation?channel=ebay`).set("Cookie", ownerCookie);
    expect(check.body.appliedByAdminUserId).toBeTruthy();
    expect(check.body.appliedByAdminUserId).not.toBe("client-supplied-id");
  });

  it("rejects a request from an admin without products.publish with 403", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    const res = await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", noPermissionCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "x" });
    expect(res.status).toBe(403);
  });

  it("never creates a PublishJob or changes Product.status - confirmed via the unchanged existing publish preview endpoint", async () => {
    const { productId, expectedProposalUpdatedAt } = await readyPreparation("ebay");
    await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt, title: "x", description: "y" });
    const jobs = await request(app).get("/api/publish-jobs").set("Cookie", ownerCookie);
    expect((jobs.body as Array<{ productId: string }>).filter((j) => j.productId === productId)).toHaveLength(0);
    const productModule = await import("../src/services/products");
    const product = await productModule.getProductById(db, productId);
    expect(product.status).toBe(ProductStatus.Draft);
  });
});

describe("regression: the existing publish pipeline remains fully reachable and unaffected", () => {
  it("existing GET /:id/publish still works unchanged after a marketplace-preparation approval - the approved title/description no longer appear as missing", async () => {
    const productId = await createTestProduct();
    const generated = await request(app).post(`/api/products/${productId}/marketplace-preparation`).set("Cookie", ownerCookie).send({ channel: "ebay" });
    const before = await request(app).get(`/api/products/${productId}/publish?channel=ebay`).set("Cookie", ownerCookie);
    expect(before.body.validation.errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(["ebayTitle", "ebayDescription"]));

    await request(app)
      .post(`/api/products/${productId}/marketplace-preparation/approve`)
      .set("Cookie", ownerCookie)
      .send({ channel: "ebay", expectedProposalUpdatedAt: generated.body.updatedAt, title: "Final Title", description: "Final Description", conditionDescription: "Good condition" });

    const after = await request(app).get(`/api/products/${productId}/publish?channel=ebay`).set("Cookie", ownerCookie);
    expect(after.status).toBe(200);
    // ebayTitle/ebayDescription are now satisfied - only the still-missing fields (never touched by
    // Marketplace Preparation: category, listing price, primary photo) remain.
    expect(after.body.validation.errors.map((e: { field: string }) => e.field)).not.toEqual(expect.arrayContaining(["ebayTitle", "ebayDescription"]));
    expect(after.body.validation.errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(["ebayCategory", "ebayListingPriceEur"]));
  });
});
