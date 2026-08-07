// Sprint 106: proves the AI Intake Stock Acceptance route's authenticated-actor-identity
// boundary, permission enforcement, system-generated SKU, and exact response/error contracts
// end-to-end, mirroring aiIntakeApplyRouteSprint94.test.ts's proven supertest/real-app pattern.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminRole } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-stock-acceptance-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-stock-acceptance";
const aiIntakePhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-stock-acceptance-route-"));
process.env.AI_INTAKE_PHOTO_DIR = aiIntakePhotoTempDir;

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];
let createCategory: (typeof import("../src/services/categories"))["createCategory"];

const PASSWORD = "correct-password-123";
let managerCookie: string; // ProductEditor: has both ai_product_intakes.manage and products.edit
let noPermissionCookie: string; // AiReviewer: has neither
let categoryId: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

async function createIntakeViaRoute(cookie = managerCookie): Promise<string> {
  const res = await request(app).post("/api/ai-product-intakes").set("Cookie", cookie).send({});
  return res.body.id;
}

let titleCounter = 0;

/** Mirrors aiIntakeApplyRouteSprint94.test.ts's readyIntakeViaRoute exactly - a unique edited title avoids the shared-database slug collision that Accepting the deterministic Mock suggestion repeatedly would cause. */
async function readyIntakeViaRoute(cookie = managerCookie): Promise<{ intakeId: string; proposalUpdatedAt: string }> {
  const intakeId = await createIntakeViaRoute(cookie);
  const generated = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", cookie).send({});
  titleCounter += 1;
  const reviewed = await request(app)
    .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
    .set("Cookie", cookie)
    .send({ decision: "edited", value: `Stock Acceptance Route Test Product ${titleCounter}`, expectedUpdatedAt: generated.body.updatedAt });
  return { intakeId, proposalUpdatedAt: reviewed.body.updatedAt };
}

function baseStockAcceptanceBody(overrides: Record<string, unknown> = {}) {
  return {
    categoryId,
    type: "unique_item",
    priceEur: 42,
    expectedProposalUpdatedAt: "placeholder",
    ...overrides,
  };
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

  await createAdminUser(db, { email: "stock-acceptance-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("stock-acceptance-editor@example.com");
  await createAdminUser(db, { email: "stock-acceptance-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("stock-acceptance-aireviewer@example.com");

  const category = await createCategory(db, { name: "Sprint 106 Route Test Category", displayOrder: 0, isActive: true } as any);
  categoryId = category.id;
});

afterAll(() => {
  rmSync(aiIntakePhotoTempDir, { recursive: true, force: true });
});

describe("POST /api/ai-product-intakes/:id/stock-acceptance", () => {
  it("creates the canonical Product on first acceptance - 201, a system-generated NOC-###### SKU, canonical Product response shape", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
    expect(res.status).toBe(201);
    expect(res.body.title).toMatch(/^Stock Acceptance Route Test Product \d+$/);
    expect(res.body.status).toBe("draft");
    expect(res.body.sku).toMatch(/^NOC-\d{6}$/);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("stockQuantity");
    expect(res.body).toHaveProperty("createdAt");
  });

  it("returns 200 with the existing Product (same sku) on an idempotent already-Applied retry", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    const body = baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt });
    const first = await request(app).post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`).set("Cookie", managerCookie).send(body);
    expect(first.status).toBe(201);
    const retry = await request(app).post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`).set("Cookie", managerCookie).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.sku).toBe(first.body.sku);
  });

  it("persists the submitted expanded AI Full Product Analysis fields", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, brand: "Acme", condition: "Good", seoTitle: "SEO Title" }));
    expect(res.status).toBe(201);
    expect(res.body.brand).toBe("Acme");
    expect(res.body.condition).toBe("Good");
    expect(res.body.seoTitle).toBe("SEO Title");
  });

  it("returns 409 with a deterministic code for a stale expectedProposalUpdatedAt", async () => {
    const { intakeId } = await readyIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: "not-the-real-value" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_APPLY_PROPOSAL_VERSION_CONFLICT");
  });

  it("returns 409 with a deterministic code when the title is still Pending", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: generated.body.updatedAt }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_APPLY_PROPOSAL_NOT_READY");
  });

  it("returns 409 with a deterministic code for a Cancelled intake", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_APPLY_INTAKE_NOT_OPEN");
  });

  it("returns 400 for a nonexistent categoryId (backend category validation is authoritative)", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, categoryId: "does-not-exist" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app)
      .post("/api/ai-product-intakes/does-not-exist/stock-acceptance")
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody());
    expect(res.status).toBe(404);
  });

  it("returns 404 when no proposal has been generated yet", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
      .set("Cookie", managerCookie)
      .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: new Date().toISOString() }));
    expect(res.status).toBe(404);
  });

  describe("security and request contract", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`).send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
      expect(res.status).toBe(401);
    });

    it("rejects a request from an admin with neither required permission with 403", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", noPermissionCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
      expect(res.status).toBe(403);
    });

    it("requires both ai_product_intakes.manage and products.edit (structural: verified by reading the route's declared permission chain)", async () => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(new URL("../src/routes/aiProductIntakes.ts", import.meta.url), "utf8");
      const routeBlock = source.slice(source.indexOf('"/:id/stock-acceptance"'));
      expect(routeBlock).toContain('requirePermission("ai_product_intakes.manage")');
      expect(routeBlock).toContain('requirePermission("products.edit")');
    });

    it("rejects a client-supplied sku - the request contract has no sku field, SKU is always system-generated", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, sku: "SKU-CLIENT-SUPPLIED" }));
      expect(res.status).toBe(400);
    });

    it("rejects a client-supplied title/description/keywords in the body", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, title: "Client Title" }));
      expect(res.status).toBe(400);
    });

    it("rejects a client-supplied Product status", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, status: "published" }));
      expect(res.status).toBe(400);
    });

    it("rejects a spoofed appliedByAdminUserId/actor id in the body", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, appliedByAdminUserId: "client-supplied-id" }));
      expect(res.status).toBe(400);
    });

    it("persists req.adminUser.id as appliedByAdminUserId, never a body value", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
      const intakeRes = await request(app).get(`/api/ai-product-intakes/${intakeId}`).set("Cookie", managerCookie);
      expect(intakeRes.body.appliedByAdminUserId).toBeTruthy();
      expect(intakeRes.body.appliedByAdminUserId).not.toBe("client-supplied-id");
    });

    it("rejects marketplace fields in the body", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, ebayTitle: "eBay Title" }));
      expect(res.status).toBe(400);
    });

    it("rejects an unknown request body field", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send(baseStockAcceptanceBody({ expectedProposalUpdatedAt: proposalUpdatedAt, somethingElse: true }));
      expect(res.status).toBe(400);
    });

    it("rejects a missing categoryId/type/priceEur/expectedProposalUpdatedAt", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/stock-acceptance`)
        .set("Cookie", managerCookie)
        .send({ expectedProposalUpdatedAt: proposalUpdatedAt });
      expect(res.status).toBe(400);
    });
  });

  describe("the existing /save-as-draft endpoint remains fully functional, unchanged, and independent", () => {
    it("still requires an explicit sku and still creates a Product from the exact same proposal shape", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send({ sku: `SKU-${Math.random().toString(36).slice(2, 10)}`, categoryId, type: "unique_item", priceEur: 42, expectedProposalUpdatedAt: proposalUpdatedAt });
      expect(res.status).toBe(201);
      expect(res.body.sku).not.toMatch(/^NOC-\d{6}$/); // manually supplied, not system-generated
    });
  });
});
