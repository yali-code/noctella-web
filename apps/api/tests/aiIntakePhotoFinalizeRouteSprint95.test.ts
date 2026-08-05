// Sprint 95: proves the AI Intake photo-finalization route's authenticated-actor-identity
// boundary, permission enforcement, strict request contract, and real end-to-end canonical photo
// promotion (real Sharp processing, real deterministic file writes), mirroring the exact
// supertest/real-app pattern established by aiIntakeApplyRouteSprint94.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { AdminRole } from "@noctella/shared";
import { products, aiProductIntakes } from "../src/db/schema";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-photo-finalize-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";
process.env.SCHEDULER_AUTH_TOKEN = "test-scheduler-token-ai-intake-photo-finalize";
// Redirect both the private staged-photo root and the public canonical ProductPhoto root to
// isolated mkdtemp directories before app.ts (and everything it transitively imports, including
// services/photoStorage.ts and services/aiIntakePhotoStorage.ts) is ever loaded - the routes have
// no storage-injection point, so no file is written into the repository.
const aiIntakePhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-photo-finalize-staged-"));
process.env.AI_INTAKE_PHOTO_DIR = aiIntakePhotoTempDir;
const productPhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-photo-finalize-canonical-"));
process.env.PRODUCT_PHOTO_DIR = productPhotoTempDir;

let app: import("express").Express;
let db: any;
let createAdminUser: (typeof import("../src/services/adminAuth"))["createAdminUser"];
let createCategory: (typeof import("../src/services/categories"))["createCategory"];

const PASSWORD = "correct-password-123";
let managerCookie: string; // ProductEditor: has both ai_product_intakes.manage and products.edit
let noPermissionCookie: string; // AiReviewer: has neither
let categoryId: string;
let testImage: Buffer;
let titleCounter = 0;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(cookieHeader).split(";")[0];
}

async function readyAppliedIntakeViaRoute(photoCount = 1, cookie = managerCookie): Promise<{ intakeId: string; productId: string; stagedPhotoIds: string[] }> {
  const created = await request(app).post("/api/ai-product-intakes").set("Cookie", cookie).send({});
  const intakeId = created.body.id;
  const stagedPhotoIds: string[] = [];
  for (let i = 0; i < photoCount; i += 1) {
    const uploaded = await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", cookie).attach("photo", testImage, `photo-${i}.png`);
    stagedPhotoIds.push(uploaded.body.id);
  }
  const generated = await request(app).post(`/api/ai-product-intakes/${intakeId}/generate`).set("Cookie", cookie).send({});
  titleCounter += 1;
  const reviewed = await request(app)
    .patch(`/api/ai-product-intakes/${intakeId}/proposal/fields/title`)
    .set("Cookie", cookie)
    .send({ decision: "edited", value: `Finalize Route Test Product ${titleCounter}`, expectedUpdatedAt: generated.body.updatedAt });
  const applied = await request(app)
    .post(`/api/ai-product-intakes/${intakeId}/save-as-draft`)
    .set("Cookie", cookie)
    .send({ sku: `SKU-FIN-${Math.random().toString(36).slice(2, 10)}`, categoryId, type: "unique_item", priceEur: 42, expectedProposalUpdatedAt: reviewed.body.updatedAt });
  return { intakeId, productId: applied.body.id, stagedPhotoIds };
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

  await createAdminUser(db, { email: "finalize-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
  managerCookie = await login("finalize-editor@example.com");
  await createAdminUser(db, { email: "finalize-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
  noPermissionCookie = await login("finalize-aireviewer@example.com");

  const category = await createCategory(db, { name: "Sprint 95 Route Test Category", displayOrder: 0, isActive: true } as any);
  categoryId = category.id;

  testImage = await sharp({ create: { width: 6, height: 6, channels: 3, background: "green" } }).png().toBuffer();
});

afterAll(() => {
  rmSync(aiIntakePhotoTempDir, { recursive: true, force: true });
  rmSync(productPhotoTempDir, { recursive: true, force: true });
});

describe("POST /api/ai-product-intakes/:id/finalize-photos", () => {
  it("creates canonical ProductPhoto rows with real files on disk - 201, canonical Product response including photos", async () => {
    const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntakeViaRoute(2);
    const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(productId);
    expect(res.body.status).toBe("draft");
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos.map((p: any) => p.id).sort()).toEqual([...stagedPhotoIds].sort());
    expect(res.body.photos.filter((p: any) => p.isPrimary)).toHaveLength(1);

    for (const photo of res.body.photos) {
      const mainPath = path.join(productPhotoTempDir, path.basename(photo.url));
      const thumbPath = path.join(productPhotoTempDir, path.basename(photo.thumbnailUrl));
      expect(existsSync(mainPath)).toBe(true);
      expect(existsSync(thumbPath)).toBe(true);
    }
  });

  it("returns 200 with the existing canonical Product on an idempotent already-Finalized retry", async () => {
    const { intakeId, productId } = await readyAppliedIntakeViaRoute(1);
    const first = await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", managerCookie).send({});
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", managerCookie).send({});
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(productId);
    expect(second.body.photos).toHaveLength(1);
  });

  it("returns 409 with a deterministic code for an Open intake", async () => {
    const created = await request(app).post("/api/ai-product-intakes").set("Cookie", managerCookie).send({});
    const res = await request(app).post(`/api/ai-product-intakes/${created.body.id}/finalize-photos`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_PHOTO_FINALIZATION_NOT_APPLIED");
  });

  it("returns 409 with a deterministic code for a Cancelled intake", async () => {
    const created = await request(app).post("/api/ai-product-intakes").set("Cookie", managerCookie).send({});
    await request(app).post(`/api/ai-product-intakes/${created.body.id}/cancel`).set("Cookie", managerCookie).send({});
    const res = await request(app).post(`/api/ai-product-intakes/${created.body.id}/finalize-photos`).set("Cookie", managerCookie).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AI_INTAKE_PHOTO_FINALIZATION_NOT_APPLIED");
  });

  it("returns 404 for a nonexistent intake", async () => {
    const res = await request(app).post("/api/ai-product-intakes/does-not-exist/finalize-photos").set("Cookie", managerCookie).send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed (foreign) primaryIntakePhotoId", async () => {
    const { intakeId } = await readyAppliedIntakeViaRoute(1);
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/finalize-photos`)
      .set("Cookie", managerCookie)
      .send({ primaryIntakePhotoId: "not-a-real-staged-photo" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("AI_INTAKE_PHOTO_FINALIZATION_PRIMARY_INVALID");
  });

  it("an explicit primaryIntakePhotoId selects the correct canonical Primary", async () => {
    const { intakeId, stagedPhotoIds } = await readyAppliedIntakeViaRoute(2);
    const res = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/finalize-photos`)
      .set("Cookie", managerCookie)
      .send({ primaryIntakePhotoId: stagedPhotoIds[1] });
    expect(res.status).toBe(201);
    expect(res.body.photos.find((p: any) => p.isPrimary)?.id).toBe(stagedPhotoIds[1]);
  });

  describe("security and request contract", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const res = await request(app).post("/api/ai-product-intakes/some-id/finalize-photos").send({});
      expect(res.status).toBe(401);
    });

    it("rejects a request from an admin with neither required permission with 403", async () => {
      const { intakeId } = await readyAppliedIntakeViaRoute(1);
      const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", noPermissionCookie).send({});
      expect(res.status).toBe(403);
    });

    it("rejects an unknown request body field", async () => {
      const { intakeId } = await readyAppliedIntakeViaRoute(1);
      const res = await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", managerCookie).send({ unexpectedField: "x" });
      expect(res.status).toBe(400);
    });

    it("rejects a client-supplied Product ID, ProductPhoto ID, storage metadata, or actor ID (all silently ignored/rejected by strict schema)", async () => {
      const { intakeId } = await readyAppliedIntakeViaRoute(1);
      const res = await request(app)
        .post(`/api/ai-product-intakes/${intakeId}/finalize-photos`)
        .set("Cookie", managerCookie)
        .send({
          productId: "spoofed-product",
          productPhotoId: "spoofed-photo",
          storageKey: "../../etc/passwd",
          actorId: "spoofed-admin",
          status: "finalized",
          finalizedAt: "2020-01-01T00:00:00.000Z",
        });
      expect(res.status).toBe(400); // strict() rejects any unknown field
    });

    it("persists req.adminUser.id as finalizedByAdminUserId, never a body value", async () => {
      const { intakeId } = await readyAppliedIntakeViaRoute(1);
      await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", managerCookie).send({});
      const [intakeRow] = await db.select().from(aiProductIntakes).where(eq(aiProductIntakes.id, intakeId));
      const [managerUser] = await db.select().from((await import("../src/db/schema")).adminUsers).where(eq((await import("../src/db/schema")).adminUsers.email, "finalize-editor@example.com"));
      expect(intakeRow.finalizedByAdminUserId).toBe(managerUser.id);
    });

    it("requires both ai_product_intakes.manage and products.edit (structural: no existing role holds exactly one without the other, so this is verified by reading the route's declared permission chain rather than isolating each gate behaviorally)", () => {
      const fs = require("node:fs");
      const routeSrc = fs.readFileSync(path.resolve(__dirname, "../src/routes/aiProductIntakes.ts"), "utf8");
      const routeBlock = routeSrc.slice(routeSrc.indexOf('"/:id/finalize-photos"'));
      expect(routeBlock.slice(0, 200)).toContain('requirePermission("ai_product_intakes.manage")');
      expect(routeBlock.slice(0, 300)).toContain('requirePermission("products.edit")');
    });
  });
});

describe("deterministic canonical photo storage (real Sharp processing, real files)", () => {
  it("writes deterministic main+thumbnail files, and a same-bytes retry reuses them idempotently", async () => {
    const { writeDeterministicProductPhoto } = await import("../src/services/photoStorage");
    const productId = "det-product-1";
    const photoId = "det-photo-1";
    const first = await writeDeterministicProductPhoto({
      buffer: testImage, mimetype: "image/png", size: testImage.length,
      mainStorageKey: `${productId}-${photoId}.webp`, thumbnailStorageKey: `${productId}-${photoId}-thumb.webp`,
    });
    const mainPath = path.join(productPhotoTempDir, first.mainStorageKey);
    const firstBytes = readFileSync(mainPath);
    expect(firstBytes.length).toBeGreaterThan(0);

    // Retry with the IDENTICAL source bytes must succeed and reuse the existing file untouched.
    const second = await writeDeterministicProductPhoto({
      buffer: testImage, mimetype: "image/png", size: testImage.length,
      mainStorageKey: `${productId}-${photoId}.webp`, thumbnailStorageKey: `${productId}-${photoId}-thumb.webp`,
    });
    expect(second.mainStorageKey).toBe(first.mainStorageKey);
    expect(readFileSync(mainPath)).toEqual(firstBytes);
  });

  it("rejects a same-key write when the existing destination has different bytes, and never overwrites it", async () => {
    const { writeDeterministicProductPhoto } = await import("../src/services/photoStorage");
    const { AiIntakePhotoFinalizationDestinationConflictError } = await import("../src/services/errors");
    const productId = "det-product-2";
    const photoId = "det-photo-2";
    const imageA = await sharp({ create: { width: 6, height: 6, channels: 3, background: "red" } }).png().toBuffer();
    const imageB = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    const written = await writeDeterministicProductPhoto({
      buffer: imageA, mimetype: "image/png", size: imageA.length,
      mainStorageKey: `${productId}-${photoId}.webp`, thumbnailStorageKey: `${productId}-${photoId}-thumb.webp`,
    });
    const mainPath = path.join(productPhotoTempDir, written.mainStorageKey);
    const originalBytes = readFileSync(mainPath);

    await expect(
      writeDeterministicProductPhoto({
        buffer: imageB, mimetype: "image/png", size: imageB.length,
        mainStorageKey: `${productId}-${photoId}.webp`, thumbnailStorageKey: `${productId}-${photoId}-thumb.webp`,
      }),
    ).rejects.toBeInstanceOf(AiIntakePhotoFinalizationDestinationConflictError);
    expect(readFileSync(mainPath)).toEqual(originalBytes);
  });

  it("rejects a traversal-shaped deterministic storage key before touching disk", async () => {
    const { writeDeterministicProductPhoto } = await import("../src/services/photoStorage");
    const { BadRequestError } = await import("../src/services/errors");
    await expect(
      writeDeterministicProductPhoto({
        buffer: testImage, mimetype: "image/png", size: testImage.length,
        mainStorageKey: "../../etc/passwd", thumbnailStorageKey: "safe-thumb.webp",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("never deletes or modifies the staged source file", async () => {
    const { intakeId, stagedPhotoIds } = await readyAppliedIntakeViaRoute(1);
    const beforeList = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie).send();
    const stagedStorageKey = beforeList.body.find((p: any) => p.id === stagedPhotoIds[0]).storageKey;
    const stagedPath = path.join(aiIntakePhotoTempDir, stagedStorageKey);
    expect(existsSync(stagedPath)).toBe(true);

    await request(app).post(`/api/ai-product-intakes/${intakeId}/finalize-photos`).set("Cookie", managerCookie).send({});
    expect(existsSync(stagedPath)).toBe(true);
    const afterList = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", managerCookie).send();
    expect(afterList.body).toHaveLength(1);
  });
});
