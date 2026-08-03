import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync } from "node:fs";
import { mkdtemp, rm as rmDir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRole } from "@noctella/shared";
import { NotFoundError, BadRequestError } from "../src/services/errors";
import { createIntake, cancelIntake } from "../src/services/aiProductIntakes";
import { deleteIntakePhoto, listIntakePhotos, uploadIntakePhoto } from "../src/services/aiIntakePhotos";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import {
  AI_INTAKE_PHOTO_MAX_BYTES,
  AI_INTAKE_PHOTO_MIME_TYPES,
  LocalAiIntakePhotoStorage,
  aiIntakePhotoStagingRoot,
} from "../src/services/aiIntakePhotoStorage";
import { createAiIntakePhotoRepository } from "../src/repositories/ai-intake-photo/factory";
import { createDrizzleAiIntakePhotoRepository } from "../src/repositories/ai-intake-photo/drizzle";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { aiIntakePhotos, products, productImages, productPhotos, stockMovements, publishJobs, externalListings } from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { requiredSprint24Tables, runSchemaParity, validatePostgresMigrationSql } from "../src/services/databaseMigrationFoundation";
import { MockAiListingProvider } from "../src/ai/mockProvider";
import { createTestDb } from "./testDb";
import { readFileSync } from "node:fs";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function mockStorage(): AiIntakePhotoStorage & { saveIntakePhoto: ReturnType<typeof vi.fn>; deleteIntakePhoto: ReturnType<typeof vi.fn> } {
  let counter = 0;
  return {
    saveIntakePhoto: vi.fn(async () => {
      counter += 1;
      return { storageKey: `mock-key-${counter}.webp` };
    }),
    deleteIntakePhoto: vi.fn(async () => {}),
  };
}

async function testImageBuffer(color = "red"): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: color } }).png().toBuffer();
}

describe("ai intake photo foundation (Sprint 91)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  describe("upload (service orchestration, mocked storage)", () => {
    it("creates a staged photo for an Open intake, recording original filename and actor", async () => {
      const storage = mockStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "front.png", "admin-2", storage);
      expect(photo.intakeId).toBe(intakeId);
      expect(photo.originalFilename).toBe("front.png");
      expect(photo.createdByAdminUserId).toBe("admin-2");
      expect(photo.storageKey).toBe("mock-key-1.webp");
    });

    it("throws NotFoundError for a nonexistent intake", async () => {
      const storage = mockStorage();
      await expect(
        uploadIntakePhoto(db as any, "does-not-exist", { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(storage.saveIntakePhoto).not.toHaveBeenCalled();
    });

    it("rejects upload against a Cancelled intake with BadRequestError, never touching storage", async () => {
      await cancelIntake(db as any, intakeId, "admin-1");
      const storage = mockStorage();
      await expect(
        uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect(storage.saveIntakePhoto).not.toHaveBeenCalled();
    });

    it("deletes the newly-written file if the database insert fails", async () => {
      const storage = mockStorage();
      sqlite.prepare("CREATE TRIGGER fail_intake_photo_insert AFTER INSERT ON ai_intake_photos BEGIN SELECT RAISE(ABORT,'forced failure'); END;").run();

      await expect(
        uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage),
      ).rejects.toThrow();

      expect(storage.deleteIntakePhoto).toHaveBeenCalledWith("mock-key-1.webp");
      expect(await db.select().from(aiIntakePhotos)).toHaveLength(0);
    });

    it("does not create a Product, ProductPhoto, ProductImage, stock movement, publish job, or external listing", async () => {
      const storage = mockStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(productPhotos)).toHaveLength(0);
      expect(await db.select().from(productImages)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
      expect(await db.select().from(publishJobs)).toHaveLength(0);
      expect(await db.select().from(externalListings)).toHaveLength(0);
    });

    it("does not invoke an AI provider", async () => {
      const spy = vi.spyOn(MockAiListingProvider.prototype, "generateListing");
      const storage = mockStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("list", () => {
    it("orders by created_at ASC then id ASC", async () => {
      // Deterministic by construction - explicit ids/timestamps via the repository directly,
      // rather than relying on uploadIntakePhoto's wall-clock createdAt and randomUUID() id both
      // happening to land in creation order. Two rows deliberately share the same createdAt to
      // prove the id ASC tiebreak; a third has a strictly later createdAt to prove the primary
      // created_at ASC ordering. Inserted out of sorted order (B, C, A) so the assertion cannot
      // pass by coincidentally matching insertion order.
      const repository = createDrizzleAiIntakePhotoRepository(db as any, sqliteSchema);
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-01-01T00:00:01.000Z"; // strictly later than t1
      const photoA = { id: "00000000-0000-4000-8000-000000000001", intakeId, storageKey: "a.webp", originalFilename: "a.png", createdByAdminUserId: "admin-1", createdAt: t1, updatedAt: t1 };
      const photoB = { id: "00000000-0000-4000-8000-000000000002", intakeId, storageKey: "b.webp", originalFilename: "b.png", createdByAdminUserId: "admin-1", createdAt: t1, updatedAt: t1 };
      const photoC = { id: "00000000-0000-4000-8000-000000000003", intakeId, storageKey: "c.webp", originalFilename: "c.png", createdByAdminUserId: "admin-1", createdAt: t2, updatedAt: t2 };

      await repository.create(photoB);
      await repository.create(photoC);
      await repository.create(photoA);

      const list = await listIntakePhotos(db as any, intakeId);
      expect(list.map((p) => p.id)).toEqual([photoA.id, photoB.id, photoC.id]);
    });

    it("isolates photos between intakes", async () => {
      const storage = mockStorage();
      const otherIntake = await createIntake(db as any, "admin-2");
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "mine.png", "admin-1", storage);
      await uploadIntakePhoto(db as any, otherIntake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "theirs.png", "admin-2", storage);

      const mine = await listIntakePhotos(db as any, intakeId);
      const theirs = await listIntakePhotos(db as any, otherIntake.id);
      expect(mine).toHaveLength(1);
      expect(theirs).toHaveLength(1);
      expect(mine[0].originalFilename).toBe("mine.png");
      expect(theirs[0].originalFilename).toBe("theirs.png");
    });

    it("is allowed for a cancelled intake", async () => {
      const storage = mockStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await cancelIntake(db as any, intakeId, "admin-1");
      const list = await listIntakePhotos(db as any, intakeId);
      expect(list).toHaveLength(1);
    });

    it("throws NotFoundError for a nonexistent intake", async () => {
      await expect(listIntakePhotos(db as any, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("delete", () => {
    it("removes the database record and the staged file", async () => {
      const storage = mockStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await deleteIntakePhoto(db as any, intakeId, photo.id, storage);
      expect(storage.deleteIntakePhoto).toHaveBeenCalledWith(photo.storageKey);
      expect(await listIntakePhotos(db as any, intakeId)).toHaveLength(0);
    });

    it("deletes the staged file BEFORE the database record (required recovery ordering)", async () => {
      const storage = mockStorage();
      let rowStillPresentWhenStorageDeleteRan = false;
      storage.deleteIntakePhoto.mockImplementation(async () => {
        // Query the DB from inside the storage-delete call itself - if the service deleted the
        // database record first (wrong order), this row would already be gone by now.
        const rows = await db.select().from(aiIntakePhotos);
        rowStillPresentWhenStorageDeleteRan = rows.length === 1;
      });
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await deleteIntakePhoto(db as any, intakeId, photo.id, storage);
      expect(rowStillPresentWhenStorageDeleteRan).toBe(true);
      expect(await listIntakePhotos(db as any, intakeId)).toHaveLength(0);
    });

    it("propagates an unexpected storage-delete failure and leaves the database record intact", async () => {
      const storage = mockStorage();
      storage.deleteIntakePhoto.mockRejectedValue(new Error("simulated unexpected storage failure (e.g. EACCES)"));
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);

      await expect(deleteIntakePhoto(db as any, intakeId, photo.id, storage)).rejects.toThrow("simulated unexpected storage failure");

      const remaining = await listIntakePhotos(db as any, intakeId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(photo.id);
    });

    it("already-missing file still allows database deletion (real storage, idempotent rm)", async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-ai-intake-photo-delete-"));
      try {
        const realStorage = new LocalAiIntakePhotoStorage(tempDir);
        const buffer = await testImageBuffer();
        const photo = await uploadIntakePhoto(db as any, intakeId, { buffer, mimetype: "image/png", size: buffer.length }, "a.png", "admin-1", realStorage);

        // Simulate the file having already been removed out-of-band before deletion is requested.
        await unlink(path.join(tempDir, photo.storageKey));
        expect(existsSync(path.join(tempDir, photo.storageKey))).toBe(false);

        await expect(deleteIntakePhoto(db as any, intakeId, photo.id, realStorage)).resolves.not.toThrow();
        expect(await listIntakePhotos(db as any, intakeId)).toHaveLength(0);
      } finally {
        await rmDir(tempDir, { recursive: true, force: true });
      }
    });

    it("a database-delete failure after successful file removal can be retried successfully", async () => {
      const storage = mockStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);

      sqlite.prepare("CREATE TRIGGER fail_intake_photo_delete AFTER DELETE ON ai_intake_photos BEGIN SELECT RAISE(ABORT,'forced delete failure'); END;").run();

      await expect(deleteIntakePhoto(db as any, intakeId, photo.id, storage)).rejects.toThrow();
      // File deletion already ran (storage is idempotent) even though the DB delete rolled back.
      expect(storage.deleteIntakePhoto).toHaveBeenCalledTimes(1);
      expect(await listIntakePhotos(db as any, intakeId)).toHaveLength(1);

      sqlite.prepare("DROP TRIGGER fail_intake_photo_delete;").run();
      await expect(deleteIntakePhoto(db as any, intakeId, photo.id, storage)).resolves.not.toThrow();
      expect(storage.deleteIntakePhoto).toHaveBeenCalledTimes(2);
      expect(await listIntakePhotos(db as any, intakeId)).toHaveLength(0);
    });

    it("rejects cross-intake deletion with NotFoundError, and does not delete the other intake's photo", async () => {
      const storage = mockStorage();
      const otherIntake = await createIntake(db as any, "admin-2");
      const photo = await uploadIntakePhoto(db as any, otherIntake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "theirs.png", "admin-2", storage);

      await expect(deleteIntakePhoto(db as any, intakeId, photo.id, storage)).rejects.toBeInstanceOf(NotFoundError);
      expect(await listIntakePhotos(db as any, otherIntake.id)).toHaveLength(1);
    });

    it("throws NotFoundError for a missing photo", async () => {
      const storage = mockStorage();
      await expect(deleteIntakePhoto(db as any, intakeId, "does-not-exist", storage)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError for a missing intake", async () => {
      const storage = mockStorage();
      await expect(deleteIntakePhoto(db as any, "does-not-exist", "does-not-exist", storage)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("is allowed for a cancelled intake", async () => {
      const storage = mockStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await cancelIntake(db as any, intakeId, "admin-1");
      await deleteIntakePhoto(db as any, intakeId, photo.id, storage);
      expect(await listIntakePhotos(db as any, intakeId)).toHaveLength(0);
    });
  });

  describe("LocalAiIntakePhotoStorage (real, unmocked, isolated temp directory)", () => {
    // Sprint 91 exact-review correction: real-storage tests must never write into the
    // repository-local apps/api/uploads/ai-intake-photos-private directory. Each test gets its
    // own os.tmpdir()-based mkdtemp directory, passed explicitly to LocalAiIntakePhotoStorage's
    // constructor (never the module-level default root), and it is forcibly removed afterward.
    let tempDir: string;
    let storage: LocalAiIntakePhotoStorage;

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-ai-intake-photo-"));
      storage = new LocalAiIntakePhotoStorage(tempDir);
    });

    afterEach(async () => {
      await rmDir(tempDir, { recursive: true, force: true });
    });

    it("rejects an unsupported MIME type before touching disk", async () => {
      await expect(storage.saveIntakePhoto({ buffer: Buffer.from("x"), mimetype: "image/gif", size: 1 })).rejects.toBeInstanceOf(BadRequestError);
    });

    it("rejects an upload larger than 10 MB before touching disk", async () => {
      await expect(
        storage.saveIntakePhoto({ buffer: Buffer.alloc(1), mimetype: "image/png", size: AI_INTAKE_PHOTO_MAX_BYTES + 1 }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("accepts exactly the three approved MIME types", () => {
      expect(AI_INTAKE_PHOTO_MIME_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
    });

    it("normalizes a real upload to a UUID-based .webp storage key, writes it into the isolated temp directory, and the file exists on disk", async () => {
      const buffer = await testImageBuffer();
      const stored = await storage.saveIntakePhoto({ buffer, mimetype: "image/png", size: buffer.length });
      expect(stored.storageKey).toMatch(/^[0-9a-f-]{36}\.webp$/);
      expect(existsSync(path.join(tempDir, stored.storageKey))).toBe(true);
      await storage.deleteIntakePhoto(stored.storageKey);
    });

    it("deletes a real staged file, and a repeated delete of an already-missing file does not throw (idempotent)", async () => {
      const buffer = await testImageBuffer();
      const stored = await storage.saveIntakePhoto({ buffer, mimetype: "image/png", size: buffer.length });
      await storage.deleteIntakePhoto(stored.storageKey);
      expect(existsSync(path.join(tempDir, stored.storageKey))).toBe(false);
      await expect(storage.deleteIntakePhoto(stored.storageKey)).resolves.not.toThrow();
    });

    it("is not served by the public product-photo static route (default staging root is private)", async () => {
      const { productPhotoStaticRoot } = await import("../src/services/photoStorage");
      expect(path.resolve(aiIntakePhotoStagingRoot)).not.toBe(path.resolve(productPhotoStaticRoot));
    });
  });

  describe("database foundation", () => {
    it("SQLite ensureSchema is idempotent for the new table", () => {
      const sqlite = new Database(":memory:");
      sqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(sqlite)).not.toThrow();
      expect(() => ensureSchema(sqlite)).not.toThrow();
      const columns = (sqlite.prepare("PRAGMA table_info(ai_intake_photos)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining(["id", "intake_id", "storage_key", "original_filename", "created_by_admin_user_id", "created_at", "updated_at"]),
      );
      sqlite.close();
    });

    it("SQLite Drizzle construction works against the new table", async () => {
      const repo = createDrizzleAiIntakePhotoRepository(db as any, sqliteSchema);
      const row = await repo.create({
        id: "sqlite-construction-check",
        intakeId,
        storageKey: "k.webp",
        originalFilename: "f.png",
        createdByAdminUserId: "admin-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(row.id).toBe("sqlite-construction-check");
    });

    it("PostgreSQL Drizzle construction remains valid for the ai-intake-photo repository", () => {
      const testDbHandle = drizzle(new Database(":memory:"), { schema: sqliteSchema });
      const repo = createDrizzleAiIntakePhotoRepository(testDbHandle as any, postgresSchema);
      expect(repo.create).toBeTypeOf("function");
      expect(repo.listByIntake).toBeTypeOf("function");
      expect(repo.findByIdAndIntake).toBeTypeOf("function");
      expect(repo.deleteById).toBeTypeOf("function");
    });

    it("the repository factory resolves sqlite, postgres, and rejects unsupported drivers", () => {
      expect(() => createAiIntakePhotoRepository("sqlite", db)).not.toThrow();
      expect(() => createAiIntakePhotoRepository("postgres", db)).not.toThrow();
      expect(() => createAiIntakePhotoRepository("nonsense-driver", db)).toThrow();
    });

    it("database parity includes ai_intake_photos", () => {
      expect(requiredSprint24Tables).toContain("ai_intake_photos");
      const parity = runSchemaParity();
      expect(parity.status).toBe("PASS");
      expect(parity.tables.find((t) => t.name === "ai_intake_photos")?.sqlite).toBe(true);
    });

    it("migration 0009 creates ai_intake_photos without dropping anything, and is included in migration validation", () => {
      const migrationSql = read("src/db/postgres-migrations/0009_sprint91_ai_intake_photo_foundation.sql");
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_intake_photos");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);

      const validation = validatePostgresMigrationSql();
      expect(validation.status).toBe("PASS");
      expect(validation.missingTables).not.toContain("ai_intake_photos");
      expect(validation.hasDrop).toBe(false);
    });
  });

  describe("permissions", () => {
    it("ProductEditor, Owner, and Admin all receive ai_product_intakes.view and .manage (reused for photos)", async () => {
      const { ROLE_PERMISSIONS } = await import("@noctella/shared");
      for (const role of [AdminRole.Owner, AdminRole.Admin, AdminRole.ProductEditor]) {
        expect(ROLE_PERMISSIONS[role]).toEqual(expect.arrayContaining(["ai_product_intakes.view", "ai_product_intakes.manage"]));
      }
    });

    it("AiReviewer does not receive any ai_product_intakes permission", async () => {
      const { ROLE_PERMISSIONS } = await import("@noctella/shared");
      expect(ROLE_PERMISSIONS[AdminRole.AiReviewer]).not.toContain("ai_product_intakes.view");
      expect(ROLE_PERMISSIONS[AdminRole.AiReviewer]).not.toContain("ai_product_intakes.manage");
    });

    it("no new permission string was added for Sprint 91", async () => {
      const { ROLE_PERMISSIONS } = await import("@noctella/shared");
      const allPermissions = new Set(Object.values(ROLE_PERMISSIONS).flat());
      const intakeRelated = [...allPermissions].filter((p) => p.startsWith("ai_product_intake") || p.startsWith("ai_intake_photo"));
      expect(intakeRelated.sort()).toEqual(["ai_product_intakes.manage", "ai_product_intakes.view"]);
    });
  });

  describe("independence from ai_listing_drafts and ProductPhoto", () => {
    it("does not reference the AI Draft system or modify photoStorage.ts's canonical logic", () => {
      const serviceSource = read("src/services/aiIntakePhotos.ts");
      const storageSource = read("src/services/aiIntakePhotoStorage.ts");
      const useCaseSource = read("src/use-cases/ai-intake-photo/useCases.ts");
      const repoSource = read("src/repositories/ai-intake-photo/drizzle.ts");
      const importLines = (source: string) => source.split("\n").filter((line) => /^\s*import /.test(line)).join("\n");
      for (const source of [serviceSource, storageSource, useCaseSource, repoSource]) {
        expect(importLines(source)).not.toMatch(/aiListingDrafts|AiDraftStatus|\/ai-draft\/|photoStorage"/);
      }
    });
  });
});
