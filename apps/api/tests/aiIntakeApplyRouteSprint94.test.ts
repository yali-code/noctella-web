// Sprint 94: proves the AI Intake Save as Draft route's authenticated-actor-identity boundary,
// permission enforcement, and exact response/error contracts end-to-end, mirroring the exact
// supertest/real-app pattern established by aiIntakeProposalRouteSprint93.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { AdminRole } from "@noctella/shared";
import { products, stockMovements } from "../src/db/schema";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-apply-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-apply";
const aiIntakePhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-apply-route-"));
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

/**
 * Edits the title to a unique value (rather than Accepting the AI suggestion) - the real
 * MockAiIntakeGenerationProvider deterministically produces the identical title for every
 * zero-photo intake, and this file shares one persistent database across all tests (matching
 * aiIntakeProposalRouteSprint93.test.ts's established convention), so Accepting the unmodified
 * suggestion repeatedly would collide on the canonical Product slug (a real, pre-existing
 * characteristic of createProductWithInventoryUseCase - no existsBySlug check exists there,
 * unrelated to Sprint 94) rather than exercising anything Sprint 94 owns.
 */
async function readyIntakeViaRoute(cookie = managerCookie): Promise<{ intakeId: string; proposalUpdatedAt: string }> {
  const intakeId = await createIntakeViaRoute(cookie);
  const generated = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", cookie).send({});
  titleCounter += 1;
  const reviewed = await request(app)
    .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
    .set("Cookie", cookie)
    .send({ decision: "edited", value: `Route Test Product ${titleCounter}`, expectedUpdatedAt: generated.body.updatedAt });
  return { intakeId, proposalUpdatedAt: reviewed.body.updatedAt };
}

function baseSaveAsDraftBody(overrides: Record<string, unknown> = {}) {
  return {
    sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
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

  await createAdminUser(db, { email: "apply-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("apply-editor@example.com");
  await createAdminUser(db, { email: "apply-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("apply-aireviewer@example.com");

  const category = await createCategory(db, { name: "Sprint 94 Route Test Category", displayOrder: 0, isActive: true } as any);
  categoryId = category.id;
});

afterAll(() => {
  rmSync(aiIntakePhotoTempDir, { recursive: true, force: true });
});

describe("POST /api/ai-product-intakes/:id/save-as-draft", () => {
  it("creates the canonical Product on first application - 201, canonical Product response shape", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
    expect(res.status).toBe(201);
    expect(res.body.title).toMatch(/^Route Test Product \d+$/);
    expect(res.body.status).toBe("draft");
    expect(res.body.sku).toBeTruthy();
    // Same shape as GET /api/products/:id / POST /api/products - not an intake-specific partial.
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("stockQuantity");
    expect(res.body).toHaveProperty("createdAt");
  });

  it("returns 200 with the existing Product on an idempotent already-Applied retry", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    const body = baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt });
    const first = await request(app).post(`/api/ai-product-intakes/${intakeId}/save-as-draft`).set("Cookie", managerCookie).send(body);
    expect(first.status).toBe(201);
    const retry = await request(app).post(`/api/ai-product-intakes/${intakeId}/save-as-draft`).set("Cookie", managerCookie).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
  });

  it("returns 409 with a deterministic code for a stale expectedProposalUpdatedAt", async () => {
    const { intakeId } = await readyIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: "not-the-real-value" }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_APPLY_PROPOSAL_VERSION_CONFLICT");
  });

  it("returns 409 with a deterministic code when the title is still Pending", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: generated.body.updatedAt }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_APPLY_PROPOSAL_NOT_READY");
  });

  it("returns 409 with a deterministic code for a Cancelled intake", async () => {
    const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_APPLY_INTAKE_NOT_OPEN");
  });

  /**
   * Sprint 98: proves the route no longer returns the previously unhandled 500 for this exact
   * collision (see this file's own readyIntakeViaRoute comment above, written at Sprint 94 time,
   * already documenting this as "a real, pre-existing characteristic ... unrelated to Sprint 94").
   * Deliberately reuses the identical title across two intakes to force the slug collision that
   * readyIntakeViaRoute's titleCounter otherwise avoids.
   */
  it("returns 409 (not the previously unhandled 500) with the safe generic conflict message when a duplicate title's derived slug collides with an existing Product", async () => {
    const duplicateTitle = "Sprint 98 Duplicate Slug Title";

    const firstIntakeId = await createIntakeViaRoute();
    const firstGenerated = await request(app).post(`/api/ai-product-intakes/${firstIntakeId}/generate`).set("Cookie", managerCookie).send({});
    const firstReviewed = await request(app)
      .patch(`/api/ai-product-intakes/${firstIntakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "edited", value: duplicateTitle, expectedUpdatedAt: firstGenerated.body.updatedAt });
    const firstSave = await request(app)
      .post(`/api/ai-product-intakes/${firstIntakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: firstReviewed.body.updatedAt }));
    expect(firstSave.status).toBe(201);

    const secondIntakeId = await createIntakeViaRoute();
    const secondGenerated = await request(app).post(`/api/ai-product-intakes/${secondIntakeId}/generate`).set("Cookie", managerCookie).send({});
    const secondReviewed = await request(app)
      .patch(`/api/ai-product-intakes/${secondIntakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "edited", value: duplicateTitle, expectedUpdatedAt: secondGenerated.body.updatedAt });
    const secondSave = await request(app)
      .post(`/api/ai-product-intakes/${secondIntakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: secondReviewed.body.updatedAt }));

    expect(secondSave.status).toBe(409);
    expect(secondSave.body.error).toBe("A product with this SKU or slug already exists.");
    expect(secondSave.body.code).toBeUndefined(); // reuses the plain ConflictError - no new error code

    const secondIntakeState = await request(app).get(`/api/ai-product-intakes/${secondIntakeId}`).set("Cookie", managerCookie);
    expect(secondIntakeState.body.status).toBe("open");
    expect(secondIntakeState.body.resultProductId).toBeFalsy();
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app)
      .post("/api/ai-product-intakes/does-not-exist/save-as-draft")
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody());
    expect(res.status).toBe(404);
  });

  it("returns 404 when no proposal has been generated yet", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
      .set("Cookie", managerCookie)
      .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: new Date().toISOString() }));
    expect(res.status).toBe(404);
  });

  describe("security and request contract", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/save-as-draft`).send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
      expect(res.status).toBe(401);
    });

    it("rejects a request from an admin with neither required permission with 403", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", noPermissionCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
      expect(res.status).toBe(403);
    });

    it("requires both ai_product_intakes.manage and products.edit (structural: no existing role holds exactly one without the other, so this is verified by reading the route's declared permission chain rather than isolating each gate behaviorally)", async () => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(new URL("../src/routes/aiProductIntakes.ts", import.meta.url), "utf8");
      const routeBlock = source.slice(source.indexOf('"/:id/save-as-draft"'));
      expect(routeBlock).toContain('requirePermission("ai_product_intakes.manage")');
      expect(routeBlock).toContain('requirePermission("products.edit")');
    });

    it("rejects a client-supplied title/description/keywords in the body", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt, title: "Client Title" }));
      expect(res.status).toBe(400);
    });

    it("rejects a client-supplied Product status", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt, status: "published" }));
      expect(res.status).toBe(400);
    });

    it("rejects a client-supplied resultProductId", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt, resultProductId: "spoofed-id" }));
      expect(res.status).toBe(400);
    });

    it("rejects a spoofed appliedByAdminUserId/actor id in the body", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt, appliedByAdminUserId: "client-supplied-id" }));
      expect(res.status).toBe(400);
    });

    it("persists req.adminUser.id as appliedByAdminUserId, never a body value", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt }));
      const intakeRes = await request(app).get(`/api/ai-product-intakes/${intakeId}`).set("Cookie", managerCookie);
      expect(intakeRes.body.appliedByAdminUserId).toBeTruthy();
      expect(intakeRes.body.appliedByAdminUserId).not.toBe("client-supplied-id");
    });

    it("rejects marketplace fields in the body", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt, ebayTitle: "eBay Title" }));
      expect(res.status).toBe(400);
    });

    it("rejects an unknown request body field", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send(baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt, somethingElse: true }));
      expect(res.status).toBe(400);
    });

    it("rejects a missing sku/categoryId/type/priceEur/expectedProposalUpdatedAt", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
        .set("Cookie", managerCookie)
        .send({ expectedProposalUpdatedAt: proposalUpdatedAt });
      expect(res.status).toBe(400);
    });
  });

  describe("Applied result-state correction (Sprint 94 correction pass)", () => {
    it("returns 409 AI_INTAKE_APPLY_RESULT_STATE_INVALID (not 404) when the Applied intake's resultProductId no longer resolves to a Product", async () => {
      const { intakeId, proposalUpdatedAt } = await readyIntakeViaRoute();
      const body = baseSaveAsDraftBody({ expectedProposalUpdatedAt: proposalUpdatedAt });
      const first = await request(app).post(`/api/ai-product-intakes/${intakeId}/save-as-draft`).set("Cookie", managerCookie).send(body);
      expect(first.status).toBe(201);
      // Simulate the Product having been removed out-of-band - delete dependent rows first.
      await db.delete(stockMovements).where(eq(stockMovements.productId, first.body.id));
      await db.delete(products).where(eq(products.id, first.body.id));
      const retry = await request(app).post(`/api/ai-product-intakes/${intakeId}/save-as-draft`).set("Cookie", managerCookie).send(body);
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe("AI_INTAKE_APPLY_RESULT_STATE_INVALID");
    });
  });
});
