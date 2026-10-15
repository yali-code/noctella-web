/**
 * #396/#390 Stage 3: W3 AI-intake upload never deletes staged bytes a committed row may reference.
 * Mirrors the W1/W10 lost-commit rule (services/products.ts): committed -> keep the file and succeed; provably
 * absent on SQLite -> compensate; PostgreSQL acknowledgement loss or an unreadable database -> keep and fail closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./testDb";
import { aiIntakePhotos } from "../src/db/schema";
import { createIntake } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto } from "../src/services/aiIntakePhotos";
import { PhotoUploadError } from "../src/services/photoUploadAdmission";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";

const control = vi.hoisted(() => ({ mode: "none" as "none" | "ack-lost" | "never-committed" | "reread-fails", driverAfterFailure: "sqlite" }));

// The real SQLite repository, with one injected failure around the locked insert and the authoritative re-read.
vi.mock("../src/repositories/ai-intake-photo/factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repositories/ai-intake-photo/factory")>();
  return {
    ...actual,
    createAiIntakePhotoRepository: (_driver?: string, db?: any) => {
      const repo = actual.createAiIntakePhotoRepository("sqlite", db) as any;
      return new Proxy(repo, {
        get(target, property) {
          if (property === "createLockedIfIntakeOpen") {
            return async (input: any) => {
              if (control.mode === "never-committed") { process.env.DATABASE_DRIVER = control.driverAfterFailure; throw Object.assign(new Error("insert rejected"), { code: "SQLITE_CONSTRAINT" }); }
              const result = await target.createLockedIfIntakeOpen(input);
              if (control.mode !== "none") { process.env.DATABASE_DRIVER = control.driverAfterFailure; throw Object.assign(new Error("connection reset after commit"), { code: "ECONNRESET" }); }
              return result;
            };
          }
          if (property === "findByIdAndIntake" && control.mode === "reread-fails") return async () => { throw new Error("database unavailable"); };
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

describe("W3 upload compensation after an uncertain commit (admission disabled, legacy path)", () => {
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;
  const savedDriver = process.env.DATABASE_DRIVER;
  const storage = () => ({ saveIntakePhoto: vi.fn(async () => ({ storageKey: "staged-key.webp" })), deleteIntakePhoto: vi.fn(async () => undefined) });
  const upload = (s: ReturnType<typeof storage>) => uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", s as unknown as AiIntakePhotoStorage);

  beforeEach(async () => {
    delete process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED;
    db = createTestDb();
    intakeId = (await createIntake(db as any, "admin-1")).id;
  });
  afterEach(() => {
    control.mode = "none"; control.driverAfterFailure = "sqlite";
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
  });

  it("committed row, lost acknowledgement: keeps the file and returns the committed photo", async () => {
    control.mode = "ack-lost";
    const s = storage();
    const photo = await upload(s);
    expect(photo.storageKey).toBe("staged-key.webp");
    expect(s.deleteIntakePhoto).not.toHaveBeenCalled();
    expect(await db.select().from(aiIntakePhotos)).toHaveLength(1);
  });

  it("unreadable database after the failure: keeps the file and fails closed (503)", async () => {
    control.mode = "reread-fails";
    const s = storage();
    const error = await upload(s).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(PhotoUploadError);
    expect((error as PhotoUploadError).status).toBe(503);
    expect(s.deleteIntakePhoto).not.toHaveBeenCalled();
  });

  it("provably absent row on SQLite: the existing compensation deletes the file and rethrows", async () => {
    control.mode = "never-committed";
    const s = storage();
    await expect(upload(s)).rejects.toThrow("insert rejected");
    expect(s.deleteIntakePhoto).toHaveBeenCalledWith("staged-key.webp");
    expect(await db.select().from(aiIntakePhotos)).toHaveLength(0);
  });

  it("absent row on PostgreSQL cannot prove rollback: keeps the file and fails closed (503)", async () => {
    control.mode = "never-committed"; control.driverAfterFailure = "postgres";
    const s = storage();
    const error = await upload(s).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(PhotoUploadError);
    expect((error as PhotoUploadError).status).toBe(503);
    expect(s.deleteIntakePhoto).not.toHaveBeenCalled();
  });
});
