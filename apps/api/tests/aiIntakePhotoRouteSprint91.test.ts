// Sprint 91: proves the AI Intake Photo routes' authenticated-actor-identity boundary and
// permission enforcement end-to-end, mirroring the exact supertest/real-app pattern established by
// aiProductIntakeRouteSprint90.test.ts / aiDraftApprovalRouteSprint89.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminRole, AiProductIntakeStatus } from "@noctella/shared";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-photo-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-photo";
// Sprint 91 exact-review correction: this file drives real multipart uploads through the real
// app, which uses aiIntakePhotoStorage.ts's default singleton (routes have no storage-injection
// point). Redirect it to an isolated mkdtemp directory before app.ts (and everything it
// transitively imports) is ever loaded, so no file is written into the repository.
const aiIntakePhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-photo-route-"));
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

async function uploadViaRoute(intakeId: string, cookie = managerCookie, filename = "front.png") {
  return request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", cookie).attach("photo", testImage, filename);
}

beforeAll(async () => {
  const appModule = await import("../src/app");
  app = appModule.default;
  const dbModule = await import("../src/db/client");
  db = dbModule.db;
  const adminAuth = await import("../src/services/adminAuth");
  createAdminUser = adminAuth.createAdminUser;

  await createAdminUser(db, { email: "photoeditor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("photoeditor@example.com");
  await createAdminUser(db, { email: "aireviewer-photo@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("aireviewer-photo@example.com");

  testImage = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
});

describe("POST /api/ai-product-intakes/:id/photos — upload", () => {
  it("uploads a photo for a permitted admin, recording req.adminUser.id and the original filename", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await uploadViaRoute(intakeId, managerCookie, "front.png");
    expect(res.status).toBe(201);
    expect(res.body.intakeId).toBe(intakeId);
    expect(res.body.originalFilename).toBe("front.png");
    expect(res.body.createdByAdminUserId).toBeTruthy();
    expect(res.body.createdByAdminUserId).not.toBe("client-supplied-id");
    expect(res.body.storageKey).toMatch(/\.webp$/);
  });

  it("rejects a request with no file attached", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie);
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported MIME type", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/photos`)
      .set("Cookie", managerCookie)
      .attach("photo", Buffer.from("not an image"), { filename: "note.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).post("/api/ai-product-intakes/does-not-exist/photos").set("Cookie", managerCookie).attach("photo", testImage, "a.png");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a Cancelled intake", async () => {
    const intakeId = await createIntakeViaRoute();
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await uploadViaRoute(intakeId, managerCookie, "too-late.png");
    expect(res.status).toBe(400);
  });

  it("requires ai_product_intakes.manage — AiReviewer is forbidden", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await uploadViaRoute(intakeId, noPermissionCookie, "forbidden.png");
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).attach("photo", testImage, "a.png");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/ai-product-intakes/:id/photos — list", () => {
  it("returns only photos belonging to the specified intake, for a permitted admin", async () => {
    const intakeId = await createIntakeViaRoute();
    await uploadViaRoute(intakeId, managerCookie, "1.png");
    await uploadViaRoute(intakeId, managerCookie, "2.png");
    const other = await createIntakeViaRoute();
    await uploadViaRoute(other, managerCookie, "other.png");

    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((p: any) => p.intakeId === intakeId)).toBe(true);
  });

  it("is allowed for a cancelled intake", async () => {
    const intakeId = await createIntakeViaRoute();
    await uploadViaRoute(intakeId, managerCookie, "1.png");
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).get("/api/ai-product-intakes/does-not-exist/photos").set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });

  it("requires ai_product_intakes.view", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", noPermissionCookie);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/ai-product-intakes/:id/photos/:photoId — delete", () => {
  it("deletes an existing staged photo for a permitted admin", async () => {
    const intakeId = await createIntakeViaRoute();
    const uploaded = await uploadViaRoute(intakeId, managerCookie, "a.png");
    const res = await request(app).delete(`/api/ai-product-intakes/${intakeId}/photos/${uploaded.body.id}`).set("Cookie", managerCookie);
    expect(res.status).toBe(204);
    const list = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie);
    expect(list.body).toHaveLength(0);
  });

  it("is allowed for a cancelled intake", async () => {
    const intakeId = await createIntakeViaRoute();
    const uploaded = await uploadViaRoute(intakeId, managerCookie, "a.png");
    await request(app).post(`/api/ai-product-intakes/${intakeId}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app).delete(`/api/ai-product-intakes/${intakeId}/photos/${uploaded.body.id}`).set("Cookie", managerCookie);
    expect(res.status).toBe(204);
  });

  it("rejects cross-intake deletion with 404", async () => {
    const intakeId = await createIntakeViaRoute();
    const otherIntakeId = await createIntakeViaRoute();
    const uploaded = await uploadViaRoute(otherIntakeId, managerCookie, "theirs.png");
    const res = await request(app).delete(`/api/ai-product-intakes/${intakeId}/photos/${uploaded.body.id}`).set("Cookie", managerCookie);
    expect(res.status).toBe(404);
    const stillThere = await request(app).get(`/api/ai-product-intakes/${otherIntakeId}/photos`).set("Cookie", managerCookie);
    expect(stillThere.body).toHaveLength(1);
  });

  it("returns 404 for a missing photo", async () => {
    const intakeId = await createIntakeViaRoute();
    const res = await request(app).delete(`/api/ai-product-intakes/${intakeId}/photos/does-not-exist`).set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing intake", async () => {
    const res = await request(app).delete("/api/ai-product-intakes/does-not-exist/photos/does-not-exist").set("Cookie", managerCookie);
    expect(res.status).toBe(404);
  });

  it("requires ai_product_intakes.manage", async () => {
    const intakeId = await createIntakeViaRoute();
    const uploaded = await uploadViaRoute(intakeId, managerCookie, "a.png");
    const res = await request(app).delete(`/api/ai-product-intakes/${intakeId}/photos/${uploaded.body.id}`).set("Cookie", noPermissionCookie);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const intakeId = await createIntakeViaRoute();
    const uploaded = await uploadViaRoute(intakeId, managerCookie, "a.png");
    const res = await request(app).delete(`/api/ai-product-intakes/${intakeId}/photos/${uploaded.body.id}`);
    expect(res.status).toBe(401);
  });
});

afterAll(() => {
  rmSync(aiIntakePhotoTempDir, { recursive: true, force: true });
});
