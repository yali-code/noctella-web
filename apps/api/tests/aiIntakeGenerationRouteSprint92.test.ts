// Sprint 92: proves the AI Intake generation route's authenticated-actor-identity boundary,
// permission enforcement, and exact response shape end-to-end, mirroring the exact
// supertest/real-app pattern established by aiIntakePhotoRouteSprint91.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminRole } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-generation-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-generation";
// Mirrors Sprint 91's exact-review correction: any photo uploaded in this file (used only to
// prove generation works with a nonzero photo count) must not be written into the repository.
const aiIntakePhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-generation-route-"));
process.env.AI_INTAKE_PHOTO_DIR = aiIntakePhotoTempDir;

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];

const PASSWORD = "correct-password-123";
let managerCookie: string;
let noPermissionCookie: string;
let testImage: Buffer;

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

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;

  await createAdminUser(db, { email: "generation-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("generation-editor@example.com");
  await createAdminUser(db, { email: "generation-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("generation-aireviewer@example.com");

  testImage = await sharp({ create: { width: 4, height: 4, channels: 3, background: "green" } }).png().toBuffer();
});

afterAll(() => {
  rmSync(aiIntakePhotoTempDir, { recursive: true, force: true });
});

describe("POST /api/ai-product-intakes/:id/generate", () => {
  it("returns exactly the required 200 response shape for a permitted admin", async () => {
    const intakeId = await createIntakeViaRoute();
    // Upload a photo first so suggestedKeywords is populated (an empty-photos intake
    // legitimately omits it, rather than sending an empty array - see the zero-photos test below).
    await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie).attach("photo", testImage, "front.png");
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["metadata", "proposal"]);
    expect(Object.keys(res.body.proposal).sort()).toEqual(
      ["confidenceScore", "suggestedDescription", "suggestedKeywords", "suggestedTitle"].sort(),
    );
    expect(Object.keys(res.body.metadata).sort()).toEqual(["promptVersion", "providerName"]);
    expect(res.body.metadata.providerName).toBe("mock-intake-v1");
    expect(res.body.metadata.promptVersion).toBe("sprint92-v1");
  });

  it("omits suggestedKeywords (rather than an empty array) for a zero-photo intake", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.proposal).not.toHaveProperty("suggestedKeywords");
  });

  it("is not a 201 (nothing is created)", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});
    expect(res.status).not.toBe(201);
  });

  it("succeeds identically whether or not the intake has staged photos", async () => {
    const intakeId = await createIntakeViaRoute();
    await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie).attach("photo", testImage, "front.png");
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.proposal.suggestedTitle).toContain("1 photo");
  });

  it("rejects an unknown request body field", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({ somethingElse: true });
    expect(res.status).toBe(400);
  });

  it("rejects a client-supplied actor identifier in the request body", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/generate`)
      .set("Cookie", managerCookie)
      .send({ createdByAdminUserId: "client-supplied-id" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).post("/api/ai-product-intakes/does-not-exist/generate").set("Cookie", managerCookie).send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 for a Cancelled intake", async () => {
    const intakeId = await createIntakeViaRoute();
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(400);
  });

  it("requires ai_product_intakes.manage — AiReviewer is forbidden", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", noPermissionCookie).send({});
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).send({});
    expect(res.status).toBe(401);
  });

  it("allows Owner and Admin roles", async () => {
    await createAdminUser(db, { email: "generation-owner@example.com", password: PASSWORD, role: AdminRole.Owner });
    const ownerCookie = await login("generation-owner@example.com");
    await createAdminUser(db, { email: "generation-admin@example.com", password: PASSWORD, role: AdminRole.Admin });
    const adminCookie = await login("generation-admin@example.com");

    for (const cookie of [ownerCookie, adminCookie]) {
      const intakeId = await createIntakeViaRoute();
      const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", cookie).send({});
      expect(res.status).toBe(200);
    }
  });

  it("does not create a GET /generations endpoint (no persistence exists to list)", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/generations`).set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });
});
