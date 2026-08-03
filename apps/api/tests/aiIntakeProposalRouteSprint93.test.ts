// Sprint 93: proves the AI Intake proposal-review routes' authenticated-actor-identity boundary,
// permission enforcement, and exact response/error contracts end-to-end, mirroring the exact
// supertest/real-app pattern established by aiIntakeGenerationRouteSprint92.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminRole } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-proposal-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-proposal";
const aiIntakePhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-proposal-route-"));
process.env.AI_INTAKE_PHOTO_DIR = aiIntakePhotoTempDir;

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

async function createIntakeViaRoute(cookie = managerCookie): Promise<string> {
  const res = await request(app).post("/api/ai-product-intakes").set("Cookie", cookie).send({});
  return res.body.id;
}

async function generateViaRoute(intakeId: string, cookie = managerCookie) {
  return request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", cookie).send({});
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;

  await createAdminUser(db, { email: "proposal-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("proposal-editor@example.com");
  await createAdminUser(db, { email: "proposal-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("proposal-aireviewer@example.com");
});

afterAll(() => {
  rmSync(aiIntakePhotoTempDir, { recursive: true, force: true });
});

describe("GET /api/ai-product-intakes/:id/proposal", () => {
  it("returns the current proposal for a permitted admin", async () => {
    const intakeId = await createIntakeViaRoute();
    await generateViaRoute(intakeId);
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/proposal`).set("Cookie", managerCookie);
    expect(res.status).toBe(200);
    expect(res.body.intakeId).toBe(intakeId);
    expect(res.body.title.decision).toBe("pending");
  });

  it("returns 404 when no proposal has been generated yet", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/proposal`).set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).get("/api/ai-product-intakes/does-not-exist/proposal").set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });

  it("remains readable for a cancelled intake", async () => {
    const intakeId = await createIntakeViaRoute();
    await generateViaRoute(intakeId);
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/proposal`).set("Cookie", managerCookie);
    expect(res.status).toBe(200);
  });

  it("requires ai_product_intakes.view", async () => {
    const intakeId = await createIntakeViaRoute();
    await generateViaRoute(intakeId);
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/proposal`).set("Cookie", noPermissionCookie);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/proposal`);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/ai-product-intakes/:id/proposal/fields/:field", () => {
  it("accepts a field, persisting req.adminUser.id as the reviewer (not a body value)", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body.title.decision).toBe("accepted");
    expect(res.body.title.reviewedByAdminUserId).toBeTruthy();
    expect(res.body.title.reviewedByAdminUserId).not.toBe("client-supplied-id");
  });

  it("edits a field with a client-supplied value", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/description`)
      .set("Cookie", managerCookie)
      .send({ decision: "edited", value: "A human-written description.", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body.description.decision).toBe("edited");
    expect(res.body.description.value).toBe("A human-written description.");
  });

  it("rejects a field", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/keywords`)
      .set("Cookie", managerCookie)
      .send({ decision: "rejected", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body.keywords.decision).toBe("rejected");
    expect(res.body.keywords.value).toBeNull();
  });

  it("edits the keywords field with an array value", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/keywords`)
      .set("Cookie", managerCookie)
      .send({ decision: "edited", value: ["Vintage", "Lamp", "vintage"], expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body.keywords.value).toEqual(["Vintage", "Lamp"]);
  });

  it("returns 400 for an unknown field name", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/category`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown request body field", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt, somethingElse: true });
    expect(res.status).toBe(400);
  });

  it("rejects a spoofed reviewer id in the request body", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt, reviewedByAdminUserId: "client-supplied-id" });
    expect(res.status).toBe(400);
  });

  it("rejects a value supplied alongside a non-Edited decision", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", value: "Should not be allowed", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(400);
  });

  it("rejects Edited with no value", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "edited", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(400);
  });

  it("returns 409 with a deterministic code for a stale expectedUpdatedAt", async () => {
    const intakeId = await createIntakeViaRoute();
    await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: "not-the-real-value" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_PROPOSAL_VERSION_CONFLICT");
  });

  it("returns 409 with a deterministic code for a stale (photo-changed) proposal", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    // Upload a real photo via sharp-generated bytes to legitimately trigger staleness.
    const sharp = (await import("sharp")).default;
    const realImage = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie).attach("photo", realImage, "a.png");
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_PROPOSAL_STALE");
  });

  it("returns 409 with a deterministic code when regeneration is attempted with a non-Pending field", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    const res = await generateViaRoute(intakeId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_PROPOSAL_REVIEW_RESET_REQUIRED");
  });

  it("returns 404 when no proposal exists for the intake", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: new Date().toISOString() });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a cancelled intake", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", managerCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(400);
  });

  it("requires ai_product_intakes.manage", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .set("Cookie", noPermissionCookie)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const intakeId = await createIntakeViaRoute();
    const generated = await generateViaRoute(intakeId);
    const res = await request(app)
      .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
      .send({ decision: "accepted", expectedUpdatedAt: generated.body.updatedAt });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/ai-product-intakes/:id/generate — Sprint 93 durability", () => {
  it("Owner and Admin roles can generate and read the proposal", async () => {
    await createAdminUser(db, { email: "proposal-owner@example.com", password: PASSWORD, role: AdminRole.Owner });
    const ownerCookie = await login("proposal-owner@example.com");
    const intakeId = await createIntakeViaRoute();
    const genRes = await generateViaRoute(intakeId, ownerCookie);
    expect(genRes.status).toBe(200);
    const getRes = await request(app).get(`/api/ai-product-intakes/${intakeId}/proposal`).set("Cookie", ownerCookie);
    expect(getRes.status).toBe(200);
  });

  it("rejects a client-supplied actor id on generate", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({ createdByAdminUserId: "client-supplied-id" });
    expect(res.status).toBe(400);
  });
});
