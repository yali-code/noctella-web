// Sprint 90: proves the AI Product Intake routes' authenticated-actor-identity boundary and
// permission enforcement end-to-end, mirroring the exact supertest/real-app pattern established by
// aiDraftApprovalRouteSprint89.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole, AiProductIntakeStatus } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-product-intake-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-product-intake";

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];

const PASSWORD = "correct-password-123";
let managerCookie: string;
let noPermissionCookie: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

async function createIntakeViaRoute(): Promise<string> {
  const res = await request(app).post("/api/ai-product-intakes").set("Cookie", managerCookie).send({});
  return res.body.id;
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;

  await createAdminUser(db, { email: "producteditor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("producteditor@example.com");
  await createAdminUser(db, { email: "aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("aireviewer@example.com");
});

describe("POST /api/ai-product-intakes — create", () => {
  it("accepts an empty body for an authenticated, permitted admin and persists req.adminUser.id, not a body value", async () => {
    const res = await request(app).post("/api/ai-product-intakes").set("Cookie", managerCookie).send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(AiProductIntakeStatus.Open);
    expect(res.body.resultProductId).toBeUndefined();
    expect(res.body.cancelledAt).toBeUndefined();
    expect(res.body.createdByAdminUserId).toBeTruthy();
    expect(res.body.createdByAdminUserId).not.toBe("client-supplied-id");
  });

  it("rejects a client-supplied createdByAdminUserId in the request body", async () => {
    const res = await request(app)
      .post("/api/ai-product-intakes")
      .set("Cookie", managerCookie)
      .send({ createdByAdminUserId: "client-supplied-id" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown request body field", async () => {
    const res = await request(app).post("/api/ai-product-intakes").set("Cookie", managerCookie).send({ somethingElse: true });
    expect(res.status).toBe(400);
  });

  it("requires ai_product_intakes.manage — AiReviewer (no intake permissions) is forbidden", async () => {
    const res = await request(app).post("/api/ai-product-intakes").set("Cookie", noPermissionCookie).send({});
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/ai-product-intakes").send({});
    expect(res.status).toBe(401);
  });
});

describe("GET /api/ai-product-intakes — list", () => {
  it("returns paginated results for a permitted admin", async () => {
    await createIntakeViaRoute();
    const res = await request(app).get("/api/ai-product-intakes").set("Cookie", managerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("pageSize");
  });

  it("rejects an invalid status filter", async () => {
    const res = await request(app).get("/api/ai-product-intakes?status=not-a-real-status").set("Cookie", managerCookie);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid page/pageSize", async () => {
    const res = await request(app).get("/api/ai-product-intakes?page=0").set("Cookie", managerCookie);
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get("/api/ai-product-intakes");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/ai-product-intakes/:id — get", () => {
  it("returns an existing intake for a permitted admin", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${id}`).set("Cookie", managerCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).get("/api/ai-product-intakes/does-not-exist").set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });

  it("requires ai_product_intakes.view", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${id}`).set("Cookie", noPermissionCookie);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/ai-product-intakes/:id/cancel — cancel", () => {
  it("cancels an Open intake, persisting req.adminUser.id (not a body value) as the canceller", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).set("Cookie", managerCookie).send({ cancellationReason: "no longer needed" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(AiProductIntakeStatus.Cancelled);
    expect(res.body.cancellationReason).toBe("no longer needed");
    expect(res.body.cancelledByAdminUserId).toBeTruthy();
    expect(res.body.cancelledByAdminUserId).not.toBe("client-supplied-id");
  });

  it("accepts an empty cancel body (cancellationReason is optional)", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(200);
  });

  it("rejects a client-supplied cancelledByAdminUserId in the request body", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${id}/cancel`)
      .set("Cookie", managerCookie)
      .send({ cancelledByAdminUserId: "client-supplied-id" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown cancel body field", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).set("Cookie", managerCookie).send({ somethingElse: true });
    expect(res.status).toBe(400);
  });

  it("a repeated cancel returns 200, not a conflict error", async () => {
    const id = await createIntakeViaRoute();
    const first = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).set("Cookie", managerCookie).send({});
    const second = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).set("Cookie", managerCookie).send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.cancelledAt).toBe(first.body.cancelledAt);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).post("/api/ai-product-intakes/does-not-exist/cancel").set("Cookie", managerCookie).send({});
    expect(res.status).toBe(404);
  });

  it("requires ai_product_intakes.manage", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).set("Cookie", noPermissionCookie).send({});
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const id = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${id}/cancel`).send({});
    expect(res.status).toBe(401);
  });
});
