// Sprint 64C: activates the role-permission model (requirePermission) on top of Sprint 64B
// admin-session authentication, and fixes the guest-checkout regression where POST /api/orders
// and POST /api/payments/initialize|verify|cancel were incorrectly placed behind requireAuth.
// Sprint 65: extends the same suite with the identical guest-offer regression fix for
// POST /api/offers (apps/storefront's MakeOfferForm.tsx calls it with no admin session).
// Exercises the real, fully-wired Express app end-to-end via supertest (see
// appMiddlewareAndAuthRoutes.test.ts for the equivalent Sprint 64B pattern this follows).
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole, ProductStatus, ProductType, ROLE_PERMISSIONS, type Permission } from "@noctella/shared";
import { hasPermission, requirePermission, type AuthedRequest } from "../src/auth/permissions";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-authz-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-authz";

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];
let offerEligibleProductId: string;

const PASSWORD = "correct-password-123";
const roleCookies = new Map<AdminRole, string>();

async function seedRoleSession(role: AdminRole): Promise<string> {
  const email = `${role}@example.com`;
  await createAdminUser(db, { email, password: PASSWORD, role });
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;
  for (const role of Object.values(AdminRole)) {
    roleCookies.set(role, await seedRoleSession(role));
  }

  const category = await createCategory(db, { name: "Offer Eligible", displayOrder: 0, isActive: true });
  const product = await createProduct(db, {
    sku: "SKU-OFFER-AUTHZ-001",
    title: "Offer Eligible Object",
    slug: "offer-eligible-object",
    type: ProductType.LotItem,
    status: ProductStatus.Published,
    categoryId: category.id,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: true,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    priceEur: 500,
    stockQuantity: 3,
  });
  offerEligibleProductId = product.id;
});

// ---------------------------------------------------------------------------
// 1. requirePermission middleware — unit tests
// ---------------------------------------------------------------------------
describe("requirePermission middleware (Sprint 64C, unit)", () => {
  function mockRes() {
    const res: any = { statusCode: 200 };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (body: any) => { res.body = body; return res; };
    return res;
  }

  it("calls next() when the authenticated role has the permission", () => {
    const req = { adminUser: { id: "u1", email: "a@example.com", role: AdminRole.Owner, status: "active" } } as unknown as AuthedRequest;
    const res = mockRes();
    let nextCalled = false;
    requirePermission("products.view")(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 (and does not call next()) when the authenticated role lacks the permission", () => {
    const req = { adminUser: { id: "u2", email: "b@example.com", role: AdminRole.SupportAgent, status: "active" } } as unknown as AuthedRequest;
    const res = mockRes();
    let nextCalled = false;
    requirePermission("products.edit")(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 (and does not call next()) when req.adminUser is unexpectedly absent", () => {
    const req = {} as AuthedRequest;
    const res = mockRes();
    let nextCalled = false;
    requirePermission("products.view")(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("Owner is granted every permission any role has, through the central ROLE_PERMISSIONS mapping", () => {
    const allPermissions = new Set<Permission>();
    for (const role of Object.values(AdminRole)) {
      for (const permission of ROLE_PERMISSIONS[role]) allPermissions.add(permission);
    }
    expect(allPermissions.size).toBeGreaterThan(0);
    for (const permission of allPermissions) {
      expect(hasPermission(AdminRole.Owner, permission)).toBe(true);
    }
  });

  it("a spoofed role/permission header on the request has no effect - only req.adminUser.role is read", () => {
    const req = {
      adminUser: { id: "u3", email: "c@example.com", role: AdminRole.SupportAgent, status: "active" },
      headers: { "x-admin-role": "owner", "x-user-role": "owner", "x-permission": "system.admin" },
    } as unknown as AuthedRequest;
    const res = mockRes();
    let nextCalled = false;
    requirePermission("system.admin")(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("fails closed (403, never throws) for a malformed/unknown role value", () => {
    const req = { adminUser: { id: "u4", email: "d@example.com", role: "not-a-real-role" as AdminRole, status: "active" } } as unknown as AuthedRequest;
    const res = mockRes();
    let nextCalled = false;
    expect(() => requirePermission("products.view")(req, res, () => { nextCalled = true; })).not.toThrow();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2. Guest checkout regression (Part 1) — the reason this sprint exists
// ---------------------------------------------------------------------------
describe("guest checkout regression fix (Sprint 64C)", () => {
  it("POST /api/orders is reachable with no session (auth does not intercept it)", async () => {
    const res = await request(app).post("/api/orders").send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400); // synthetic empty body fails order validation, not auth
  });

  it("POST /api/payments/initialize is reachable with no session", async () => {
    const res = await request(app).post("/api/payments/initialize").send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("POST /api/payments/verify is reachable with no session", async () => {
    const res = await request(app).post("/api/payments/verify").send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("POST /api/payments/cancel is reachable with no session", async () => {
    const res = await request(app).post("/api/payments/cancel").send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("does not require ADMIN_APP_ORIGIN for the public guest-checkout routes", async () => {
    const res = await request(app).post("/api/orders").set("Origin", "http://localhost:3000").send({});
    expect(res.status).not.toBe(403);
  });

  it("the storefront origin is CORS-allowed (browser can read the public checkout response)", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("GET /api/orders (administrative) still requires a session - returns 401 with none", async () => {
    const res = await request(app).get("/api/orders");
    expect(res.status).toBe(401);
  });

  it("PATCH /api/orders/:id/status (administrative) still requires a session - returns 401 with none", async () => {
    const res = await request(app).patch("/api/orders/nonexistent/status").send({ status: "Paid" });
    expect(res.status).toBe(401);
  });

  it("GET /api/payments (administrative) still requires a session - returns 401 with none", async () => {
    const res = await request(app).get("/api/payments");
    expect(res.status).toBe(401);
  });

  it("an authenticated role without orders.view gets 403, not 401, on GET /api/orders", async () => {
    const cookie = roleCookies.get(AdminRole.ProductEditor)!;
    const res = await request(app).get("/api/orders").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("the complete orders router is not accidentally public - only POST / is reachable without a session", async () => {
    const res = await request(app).get("/api/orders/some-id");
    expect(res.status).toBe(401);
  });

  it("the complete payments router is not accidentally public - GET / still requires a session", async () => {
    const res = await request(app).get("/api/payments").set("Origin", "http://localhost:3000");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2b. Guest offer submission regression (Sprint 65) - same class of bug as Part 1 above,
//     for apps/storefront's MakeOfferForm.tsx, which calls POST /api/offers with no session.
// ---------------------------------------------------------------------------
describe("guest offer submission regression fix (Sprint 65)", () => {
  it("POST /api/offers is reachable with no session (auth does not intercept it)", async () => {
    const res = await request(app).post("/api/offers").send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400); // synthetic empty body fails offer validation, not auth
  });

  it("does not require ADMIN_APP_ORIGIN for the public guest-offer route", async () => {
    const res = await request(app).post("/api/offers").set("Origin", "http://localhost:3000").send({});
    expect(res.status).not.toBe(403);
  });

  it("public offer creation preserves existing validation and response behavior", async () => {
    const res = await request(app).post("/api/offers").send({
      productId: offerEligibleProductId,
      customerName: "Jane Collector",
      customerEmail: "jane@example.com",
      offeredAmount: 250,
      currency: "EUR",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      productId: offerEligibleProductId,
      customerName: "Jane Collector",
      customerEmail: "jane@example.com",
      offeredAmount: 250,
      currency: "EUR",
      status: "pending",
    });
  });

  it("GET /api/offers (administrative) still requires a session - returns 401 with none", async () => {
    const res = await request(app).get("/api/offers");
    expect(res.status).toBe(401);
  });

  it("the complete offers router is not accidentally public - protected mutations still require a session", async () => {
    const res = await request(app).post("/api/offers/some-id/accept").send({});
    expect(res.status).toBe(401);
  });

  it("an authenticated role without orders.manage gets 403, not 401, on a protected offer mutation", async () => {
    const cookie = roleCookies.get(AdminRole.ProductEditor)!;
    const res = await request(app).post("/api/offers/some-id/accept").set("Cookie", cookie).send({});
    expect(res.status).toBe(403);
  });

  it("OrderManager (has orders.manage) reaches the handler, not 401/403, on a protected offer mutation", async () => {
    const cookie = roleCookies.get(AdminRole.OrderManager)!;
    const res = await request(app).post("/api/offers/some-id/accept").set("Cookie", cookie).send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("Admin (has orders.manage) reaches the handler, not 401/403, on a protected offer mutation", async () => {
    const cookie = roleCookies.get(AdminRole.Admin)!;
    const res = await request(app).post("/api/offers/some-id/accept").set("Cookie", cookie).send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. Router authorization wiring - representative route per permission-protected router
//    Also doubles as the 401 vs 403 vs success HTTP-status matrix.
// ---------------------------------------------------------------------------
const REPRESENTATIVE_ROUTES: { router: string; method: "get" | "post"; path: string; permission: Permission }[] = [
  { router: "products.ts", method: "get", path: "/api/products", permission: "products.view" },
  { router: "products.ts", method: "get", path: "/api/products/missing/lifecycle", permission: "products.publish" },
  { router: "products.ts", method: "post", path: "/api/products/missing/lifecycle/pause", permission: "products.publish" },
  { router: "products.ts", method: "post", path: "/api/products/missing/lifecycle/relist", permission: "products.publish" },
  { router: "products.ts", method: "post", path: "/api/products/missing/lifecycle/missing/retry", permission: "products.publish" },
  { router: "orders.ts", method: "get", path: "/api/orders", permission: "orders.view" },
  { router: "shipments.ts", method: "get", path: "/api/shipments", permission: "orders.view" },
  { router: "returns.ts", method: "get", path: "/api/returns", permission: "orders.view" },
  { router: "categories.ts", method: "get", path: "/api/categories", permission: "products.view" },
  { router: "collections.ts", method: "get", path: "/api/collections", permission: "products.view" },
  { router: "stockMovements.ts", method: "get", path: "/api/stock-movements", permission: "products.edit" },
  { router: "offers.ts", method: "get", path: "/api/offers", permission: "orders.view" },
  { router: "payments.ts", method: "get", path: "/api/payments", permission: "orders.view" },
  { router: "aiDrafts.ts", method: "get", path: "/api/ai-drafts", permission: "ai_drafts.view" },
  { router: "ai.ts", method: "get", path: "/api/ai", permission: "ai_drafts.view" },
  { router: "marketplaces.ts", method: "get", path: "/api/marketplaces/connections", permission: "marketplace.view" },
  { router: "marketplaceAdmin.ts", method: "get", path: "/api/external-listings", permission: "marketplace.view" },
  { router: "publishJobs.ts", method: "get", path: "/api/publish-jobs", permission: "marketplace.view" },
  { router: "backgroundJobs.ts", method: "get", path: "/api/background-jobs", permission: "marketplace.view" },
  { router: "stockSync.ts", method: "get", path: "/api/stock-sync/status", permission: "marketplace.view" },
  { router: "analytics.ts", method: "get", path: "/api/analytics", permission: "analytics.view" },
  { router: "liveVisitors.ts", method: "get", path: "/api/live-visitors", permission: "analytics.view" },
  { router: "settings.ts", method: "get", path: "/api/settings", permission: "settings.manage" },
  { router: "databaseAdmin.ts", method: "get", path: "/api/admin/database/health", permission: "system.admin" },
];

describe("router authorization wiring (Sprint 64C)", () => {
  for (const { router, method, path, permission } of REPRESENTATIVE_ROUTES) {
    describe(`${router}: ${method.toUpperCase()} ${path} requires ${permission}`, () => {
      it("401 with no session at all", async () => {
        const res = await request(app)[method](path);
        expect(res.status).toBe(401);
      });

      it("403 for an authenticated session whose role lacks the permission", async () => {
        const forbiddenRole = Object.values(AdminRole).find((r) => !ROLE_PERMISSIONS[r].includes(permission));
        expect(forbiddenRole).toBeDefined();
        const cookie = roleCookies.get(forbiddenRole!)!;
        const res = await request(app)[method](path).set("Cookie", cookie);
        expect(res.status).toBe(403);
      });

      it("reaches the handler (not 401/403) for a role with the permission", async () => {
        const cookie = roleCookies.get(AdminRole.Owner)!;
        const res = await request(app)[method](path).set("Cookie", cookie);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });
  }

  describe("customers.ts placeholder: requireAuth only, no permission gate", () => {
    it("401 with no session", async () => {
      const res = await request(app).get("/api/customers");
      expect(res.status).toBe(401);
    });

    it("any authenticated role reaches the handler, regardless of permissions", async () => {
      const cookie = roleCookies.get(AdminRole.SupportAgent)!;
      const res = await request(app).get("/api/customers").set("Cookie", cookie);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Role-permission matrix - one seeded session per role, allowed + forbidden route
// ---------------------------------------------------------------------------
describe("role-permission matrix (Sprint 64C)", () => {
  it("Owner: reaches an Owner-only system.admin route", async () => {
    const cookie = roleCookies.get(AdminRole.Owner)!;
    const res = await request(app).get("/api/admin/database/health").set("Cookie", cookie);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("Admin: reaches marketplace.view/manage/analytics.view routes but not system.admin (not users.manage)", async () => {
    const cookie = roleCookies.get(AdminRole.Admin)!;
    const marketplaceRes = await request(app).get("/api/marketplaces/connections").set("Cookie", cookie);
    expect(marketplaceRes.status).not.toBe(401);
    expect(marketplaceRes.status).not.toBe(403);

    const analyticsRes = await request(app).get("/api/analytics").set("Cookie", cookie);
    expect(analyticsRes.status).not.toBe(401);
    expect(analyticsRes.status).not.toBe(403);

    const dbAdminRes = await request(app).get("/api/admin/database/health").set("Cookie", cookie);
    expect(dbAdminRes.status).toBe(403);
  });

  it("ProductEditor: reaches products.view/edit routes but not orders.view", async () => {
    const cookie = roleCookies.get(AdminRole.ProductEditor)!;
    const allowed = await request(app).get("/api/products").set("Cookie", cookie);
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);

    const forbidden = await request(app).get("/api/orders").set("Cookie", cookie);
    expect(forbidden.status).toBe(403);
  });

  it("OrderManager: reaches orders.view/manage/customers.view routes but not products.view", async () => {
    const cookie = roleCookies.get(AdminRole.OrderManager)!;
    const allowed = await request(app).get("/api/orders").set("Cookie", cookie);
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);

    const forbidden = await request(app).get("/api/products").set("Cookie", cookie);
    expect(forbidden.status).toBe(403);
  });

  it("SupportAgent: reaches orders.view/customers.view but not orders.manage mutations", async () => {
    const cookie = roleCookies.get(AdminRole.SupportAgent)!;
    const allowed = await request(app).get("/api/orders").set("Cookie", cookie);
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);

    const forbidden = await request(app).patch("/api/orders/nonexistent/status").set("Cookie", cookie).send({ status: "Paid" });
    expect(forbidden.status).toBe(403);
  });

  it("AiReviewer: reaches ai_drafts.view/review and products.view but not orders.view", async () => {
    const cookie = roleCookies.get(AdminRole.AiReviewer)!;
    const allowed = await request(app).get("/api/ai-drafts").set("Cookie", cookie);
    expect(allowed.status).not.toBe(401);
    expect(allowed.status).not.toBe(403);

    const forbidden = await request(app).get("/api/orders").set("Cookie", cookie);
    expect(forbidden.status).toBe(403);
  });
});

describe("Sprint 149 lifecycle HTTP input isolation",()=>{
  it.each(["actorAdminUserId","expectedUpdatedAt","connectionId","channel","channels","allowPaused","bypassPause","lifecycleBypass","stockQuantity","price","title"])("strictly rejects Relist field %s",async(field)=>{const res=await request(app).post("/api/products/missing/lifecycle/relist").set("Cookie",roleCookies.get(AdminRole.Owner)!).send({idempotencyKey:"relist-http-key",[field]:field==="channels"?[]:"controlled"});expect(res.status).toBe(400);});
  it.each(["actorAdminUserId","expectedUpdatedAt","stockQuantity","channel","allowPaused"])("strictly rejects Pause field %s",async(field)=>{const res=await request(app).post("/api/products/missing/lifecycle/pause").set("Cookie",roleCookies.get(AdminRole.Owner)!).send({idempotencyKey:"pause-http-key",[field]:"controlled"});expect(res.status).toBe(400);});
  it("does not allow Retry request-body controls to influence lifecycle dispatch",async()=>{const res=await request(app).post("/api/products/missing/lifecycle/missing/retry").set("Cookie",roleCookies.get(AdminRole.Owner)!).send({connectionId:"alternate",channel:"etsy",allowPaused:true,actorAdminUserId:"forged",title:"forged"});expect(res.status).toBe(404);});
  it("cannot expose the internal pause bypass through ordinary publish HTTP input",async()=>{const category=await createCategory(db,{name:`Paused publish ${crypto.randomUUID()}`,displayOrder:0,isActive:true}),product=await createProduct(db,{sku:`PAUSED-${crypto.randomUUID()}`,title:"Paused",type:ProductType.UniqueItem,status:ProductStatus.Draft,categoryId:category.id,stockQuantity:1,priceEur:10,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false});await db.update(schema.products).set({salePausedAt:new Date().toISOString()}).where(eq(schema.products.id,product.id));for(const field of ["allowPaused","bypassPause","lifecycleBypass","exactConnectionId"]){const res=await request(app).post(`/api/products/${product.id}/publish/execute`).set("Cookie",roleCookies.get(AdminRole.Owner)!).send({channel:"ebay",[field]:true});expect(res.status).not.toBe(200);expect(res.body?.error).toMatch(/Paused Product/);}});
});

describe("Sprint 149 Archive safety HTTP contract",()=>{
  it("returns 409 for fresh unsafe marketplace state while preserving products.edit authorization",async()=>{const category=await createCategory(db,{name:`Archive safety ${crypto.randomUUID()}`,displayOrder:0,isActive:true}),product=await createProduct(db,{sku:`ARCHIVE-${crypto.randomUUID()}`,title:"Archive unsafe",type:ProductType.UniqueItem,status:ProductStatus.Draft,categoryId:category.id,stockQuantity:1,priceEur:10,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false});await db.insert(schema.marketplaceConnections).values({id:`archive-connection-${product.id}`,channel:"ebay",accountLabel:`archive-${product.id}`,status:"connected",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});await db.insert(schema.externalListings).values({id:`archive-listing-${product.id}`,productId:product.id,channel:"ebay",connectionId:`archive-connection-${product.id}`,externalListingId:`archive-remote-${product.id}`,externalStatus:"active",payloadSnapshot:"{}",publishedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});const forbiddenRole=Object.values(AdminRole).find(role=>!ROLE_PERMISSIONS[role].includes("products.edit"))!;expect((await request(app).post(`/api/products/${product.id}/archive`).set("Cookie",roleCookies.get(forbiddenRole)!)).status).toBe(403);const response=await request(app).post(`/api/products/${product.id}/archive`).set("Cookie",roleCookies.get(AdminRole.Owner)!);expect(response.status).toBe(409);expect(response.body.error).toMatch(/cannot be archived/i);expect((await db.select().from(schema.products).where(eq(schema.products.id,product.id)))[0].status).toBe(ProductStatus.Draft);});
});
