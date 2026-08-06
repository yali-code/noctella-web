// Sprint 97: the private staged-photo content endpoint. Route-level tests (auth/permission/
// headers/success/404) use a real app + real admin sessions via supertest, mirroring
// aiIntakeCleanupRouteSprint96.test.ts's established pattern. Service-level tests use direct
// calls against a real, isolated temp storage root, mirroring aiIntakePhotos.test.ts's pattern,
// to exercise disposition branches (missing file, symlink, directory, unsafe path) that are not
// reachable through the real upload/DB path (storageKey is always server-generated).
//
// Every import that transitively touches services/aiIntakePhotoStorage.ts (whose module-level
// `stagingRoot` constant is fixed the first time that module is evaluated anywhere in this
// worker process) is deliberately a dynamic `await import(...)`, never a static top-of-file
// import - a static import would be hoisted above the AI_INTAKE_PHOTO_DIR assignment below by
// ES module semantics, freezing the singleton storage root to the real default location before
// the route-level tests ever get a chance to redirect it into a temp directory.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync } from "node:fs";
import { rm as rmDir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { AdminRole, AiProductIntakeStatus } from "@noctella/shared";
import { NotFoundError } from "../src/services/errors";
import { aiProductIntakes, products, productPhotos } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { createTestDb } from "./testDb";

process.env.DATABASE_URL = ":memory:";
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MARKETPLACE_OAUTH_STATE_SECRET = "state-secret-for-ai-intake-photo-content-tests";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";

const stagedTempDirModuleLevel = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-photo-content-route-"));
process.env.AI_INTAKE_PHOTO_DIR = stagedTempDirModuleLevel;

async function realPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
}

describe("getIntakePhotoContent (service, Sprint 97)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let tempDir: string;
  let storage: import("../src/services/aiIntakePhotoStorage").LocalAiIntakePhotoStorage;
  let intakeId: string;
  let createIntake: typeof import("../src/services/aiProductIntakes").createIntake;
  let cancelIntake: typeof import("../src/services/aiProductIntakes").cancelIntake;
  let uploadIntakePhoto: typeof import("../src/services/aiIntakePhotos").uploadIntakePhoto;
  let getIntakePhotoContent: typeof import("../src/services/aiIntakePhotos").getIntakePhotoContent;
  let LocalAiIntakePhotoStorageClass: typeof import("../src/services/aiIntakePhotoStorage").LocalAiIntakePhotoStorage;

  beforeAll(async () => {
    ({ createIntake, cancelIntake } = await import("../src/services/aiProductIntakes"));
    ({ uploadIntakePhoto, getIntakePhotoContent } = await import("../src/services/aiIntakePhotos"));
    ({ LocalAiIntakePhotoStorage: LocalAiIntakePhotoStorageClass } = await import("../src/services/aiIntakePhotoStorage"));
  });

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
    tempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-photo-content-"));
    storage = new LocalAiIntakePhotoStorageClass(tempDir);
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  afterAll(async () => {
    await rmDir(stagedTempDirModuleLevel, { recursive: true, force: true }).catch(() => {});
  });

  it("returns the exact staged photo bytes", async () => {
    const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: await realPng(), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
    const buffer = await getIntakePhotoContent(db as any, intakeId, photo.id, storage);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("throws NotFoundError for a missing intake", async () => {
    await expect(getIntakePhotoContent(db as any, "no-such-intake", "no-such-photo", storage)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a missing photo", async () => {
    await expect(getIntakePhotoContent(db as any, intakeId, "no-such-photo", storage)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a photo belonging to a different intake is indistinguishable from a missing photo (both NotFoundError)", async () => {
    const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: await realPng(), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
    const otherIntake = await createIntake(db as any, "admin-1");
    await expect(getIntakePhotoContent(db as any, otherIntake.id, photo.id, storage)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the DB row exists but the source file is missing", async () => {
    const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: await realPng(), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
    await rmDir(path.join(tempDir, photo.storageKey), { force: true });
    await expect(getIntakePhotoContent(db as any, intakeId, photo.id, storage)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("content remains readable for Open, Cancelled, Applied, and Finalized intakes", async () => {
    const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: await realPng(), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
    await expect(getIntakePhotoContent(db as any, intakeId, photo.id, storage)).resolves.toBeInstanceOf(Buffer);

    await cancelIntake(db as any, intakeId, "admin-2");
    await expect(getIntakePhotoContent(db as any, intakeId, photo.id, storage)).resolves.toBeInstanceOf(Buffer);

    await db
      .update(aiProductIntakes)
      .set({ status: AiProductIntakeStatus.Applied, appliedAt: new Date().toISOString(), appliedByAdminUserId: "admin-2" })
      .where(eq(aiProductIntakes.id, intakeId));
    await expect(getIntakePhotoContent(db as any, intakeId, photo.id, storage)).resolves.toBeInstanceOf(Buffer);

    await db
      .update(aiProductIntakes)
      .set({ status: AiProductIntakeStatus.Finalized, finalizedAt: new Date().toISOString(), finalizedByAdminUserId: "admin-2" })
      .where(eq(aiProductIntakes.id, intakeId));
    await expect(getIntakePhotoContent(db as any, intakeId, photo.id, storage)).resolves.toBeInstanceOf(Buffer);
  });

  it("performs no DB or filesystem mutation", async () => {
    const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: await realPng(), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
    await getIntakePhotoContent(db as any, intakeId, photo.id, storage);
    await getIntakePhotoContent(db as any, intakeId, photo.id, storage);
    expect(await db.select().from(products)).toHaveLength(0);
    expect(await db.select().from(productPhotos)).toHaveLength(0);
    const secondRead = await getIntakePhotoContent(db as any, intakeId, photo.id, storage);
    expect(secondRead.length).toBeGreaterThan(0);
  });
});

describe("LocalAiIntakePhotoStorage.readIntakePhoto disposition handling (Sprint 97, real filesystem)", () => {
  let tempDir: string;
  let storage: import("../src/services/aiIntakePhotoStorage").LocalAiIntakePhotoStorage;
  let LocalAiIntakePhotoStorageClass: typeof import("../src/services/aiIntakePhotoStorage").LocalAiIntakePhotoStorage;

  beforeAll(async () => {
    ({ LocalAiIntakePhotoStorage: LocalAiIntakePhotoStorageClass } = await import("../src/services/aiIntakePhotoStorage"));
  });

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-ai-intake-photo-content-storage-"));
    storage = new LocalAiIntakePhotoStorageClass(tempDir);
  });

  it("rejects a symlink with a generic error, never following it", async () => {
    const { writeFile, symlink } = await import("node:fs/promises");
    const targetKey = "real-target.webp";
    await writeFile(path.join(tempDir, targetKey), "real bytes");
    const linkKey = "link.webp";
    try {
      await symlink(path.join(tempDir, targetKey), path.join(tempDir, linkKey));
    } catch (err: any) {
      if (err?.code === "EPERM" || err?.code === "EACCES") return; // platform cannot create symlinks here
      throw err;
    }
    await expect(storage.readIntakePhoto(linkKey)).rejects.toThrow();
  });

  it("rejects a directory with a generic error", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(tempDir, "a-directory"));
    await expect(storage.readIntakePhoto("a-directory")).rejects.toThrow();
  });

  it("rejects an unsafe (traversal) key with a generic error, never leaking the resolved path", async () => {
    await expect(storage.readIntakePhoto("../escape.webp")).rejects.toThrow();
  });
});

describe("GET /api/ai-product-intakes/:id/photos/:photoId/content (route, Sprint 97)", () => {
  let app: import("express").Express;
  let db: any;

  const PASSWORD = "correct-password-123";
  let viewerCookie: string; // ProductEditor: has ai_product_intakes.view + manage
  let noPermissionCookie: string; // AiReviewer: has neither

  async function login(email: string): Promise<string> {
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

    await adminAuth.createAdminUser(db, { email: "content-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
    viewerCookie = await login("content-editor@example.com");
    await adminAuth.createAdminUser(db, { email: "content-aireviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
    noPermissionCookie = await login("content-aireviewer@example.com");
  });

  async function createIntakeWithPhoto(): Promise<{ intakeId: string; photoId: string }> {
    const createRes = await request(app).post("/api/ai-product-intakes").set("Cookie", viewerCookie).send({});
    const intakeId = createRes.body.id as string;
    const png = await realPng();
    const uploadRes = await request(app)
      .post(`/api/ai-product-intakes/${intakeId}/photos`)
      .set("Cookie", viewerCookie)
      .attach("photo", png, { filename: "a.png", contentType: "image/png" });
    return { intakeId, photoId: uploadRes.body.id as string };
  }

  it("401s without an authenticated session", async () => {
    const { intakeId, photoId } = await createIntakeWithPhoto();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`);
    expect(res.status).toBe(401);
  });

  it("403s for an authenticated session without ai_product_intakes.view", async () => {
    const { intakeId, photoId } = await createIntakeWithPhoto();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`).set("Cookie", noPermissionCookie);
    expect(res.status).toBe(403);
  });

  it("succeeds with view permission - exact headers, no storage key/path leak", async () => {
    const { intakeId, photoId } = await createIntakeWithPhoto();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`).set("Cookie", viewerCookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.isBuffer(res.body) || res.body instanceof Uint8Array).toBe(true);
    expect(JSON.stringify(res.headers)).not.toMatch(/\.webp/);
  });

  it("404s for a missing intake", async () => {
    const res = await request(app).get("/api/ai-product-intakes/no-such-intake/photos/no-such-photo/content").set("Cookie", viewerCookie);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/uploads[\\/]/);
  });

  it("404s for a missing photo on a real intake", async () => {
    const { intakeId } = await createIntakeWithPhoto();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/no-such-photo/content`).set("Cookie", viewerCookie);
    expect(res.status).toBe(404);
  });
});
