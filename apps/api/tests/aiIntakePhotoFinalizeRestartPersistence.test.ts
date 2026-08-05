// Sprint 95 critical correction: the required restart-persistence test for AI intake photo
// finalization, mirroring databaseRestartPersistence.test.ts's established two-independent-
// runtimes-over-the-same-file technique, extended to also cover the private staged-photo storage
// root and the public canonical ProductPhoto storage root - a real file-backed SQLite database and
// real filesystem roots, all in temporary directories outside the repository, all removed after
// the test. PRODUCT_PHOTO_DIR is set before any dynamic import of a module that transitively loads
// services/photoStorage.ts (whose storage root is a module-level constant read at first import),
// mirroring aiIntakePhotoFinalizeRouteSprint95.test.ts's established convention.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";

const dbTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-sprint95-restart-db-"));
const stagedPhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-sprint95-restart-staged-"));
const canonicalPhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-sprint95-restart-canonical-"));
process.env.PRODUCT_PHOTO_DIR = canonicalPhotoTempDir;

afterAll(() => {
  rmSync(dbTempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(stagedPhotoTempDir, { recursive: true, force: true });
  rmSync(canonicalPhotoTempDir, { recursive: true, force: true });
});

describe("Sprint 95 critical correction: AI intake photo finalization restart persistence", () => {
  it("persists Finalized intake state, canonical ProductPhoto rows/Primary, staged rows, and all real files across two independent runtimes reopened against the same files", async () => {
    const dbFile = path.join(dbTempDir, "sprint95-restart-test.sqlite");
    const { createDatabaseRuntime } = await import("../src/db/runtime");
    const env = { DATABASE_DRIVER: "sqlite", DATABASE_URL: dbFile } as unknown as NodeJS.ProcessEnv;

    const { AiIntakeFieldDecision, ProductType, AiProductIntakeStatus } = await import("@noctella/shared");
    const schema = await import("../src/db/schema");
    const { createCategory } = await import("../src/services/categories");
    const { createIntake, getIntakeById } = await import("../src/services/aiProductIntakes");
    const { uploadIntakePhoto, listIntakePhotos } = await import("../src/services/aiIntakePhotos");
    const { generateIntakeProposal } = await import("../src/services/aiIntakeGeneration");
    const { updateProposalFieldReview } = await import("../src/services/aiIntakeProposals");
    const { saveAiIntakeAsDraft } = await import("../src/services/aiIntakeApply");
    const { finalizeAiIntakePhotos } = await import("../src/services/aiIntakePhotoFinalization");
    const { LocalAiIntakePhotoStorage } = await import("../src/services/aiIntakePhotoStorage");
    const { LocalAiIntakePhotoReader } = await import("../src/ai-intake/photoReader");
    const { createIntakeScopedPhotoStorageKeyResolver } = await import("../src/services/aiIntakePhotoStorageKeyResolver");
    const { writeDeterministicProductPhoto } = await import("../src/services/photoStorage");

    // ---- "first process run": real schema init, real intake -> photo -> proposal -> apply -> finalize ----
    const first = createDatabaseRuntime(env);
    const dbFirst = first.db as any;

    const category = await createCategory(dbFirst, { name: "Restart Category", displayOrder: 0, isActive: true } as any);
    const intake = await createIntake(dbFirst, "admin-1");
    const stagedStorage = new LocalAiIntakePhotoStorage(stagedPhotoTempDir);
    const buffer = await sharp({ create: { width: 5, height: 5, channels: 3, background: "purple" } }).png().toBuffer();
    const photo = await uploadIntakePhoto(dbFirst, intake.id, { buffer, mimetype: "image/png", size: buffer.length }, "a.png", "admin-1", stagedStorage);

    const stubProvider = {
      generate: async (req: any) => ({
        proposal: { suggestedTitle: "Restart Title", suggestedDescription: "Restart description.", suggestedKeywords: ["restart", "test"], confidenceScore: 0.9 },
        metadata: { providerName: "stub-provider", promptVersion: req.prompt.version },
      }),
    };
    const generated = await generateIntakeProposal(dbFirst, intake.id, stubProvider as any);
    const reviewed = await updateProposalFieldReview(dbFirst, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
    const applied = await saveAiIntakeAsDraft(
      dbFirst,
      intake.id,
      { sku: "SKU-SPRINT95-RESTART", categoryId: category.id, type: ProductType.UniqueItem, priceEur: 42, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
      "admin-3",
    );

    const manifestDeps = {
      readStagedPhotoBytes: (stagedPhotoId: string) => {
        const reader = new LocalAiIntakePhotoReader(createIntakeScopedPhotoStorageKeyResolver(dbFirst, intake.id), stagedPhotoTempDir);
        return reader.read(stagedPhotoId);
      },
      writeDeterministicPhoto: (input: any) => writeDeterministicProductPhoto(input),
    };

    const result = await finalizeAiIntakePhotos(dbFirst, intake.id, {}, "admin-4", manifestDeps as any);
    expect(result.created).toBe(true);
    const productId = result.product.id;
    expect(productId).toBe(applied.product.id);

    await first.shutdown();

    // ---- "second process run": reopen the DB connection, reconstruct every repository/service/
    // storage layer fresh, against the same underlying files - never reusing the first run's
    // in-memory objects ----
    const second = createDatabaseRuntime(env);
    const dbSecond = second.db as any;

    const intakeAfterRestart = await getIntakeById(dbSecond, intake.id);
    expect(intakeAfterRestart.status).toBe(AiProductIntakeStatus.Finalized);
    expect(intakeAfterRestart.resultProductId).toBe(productId);
    expect(intakeAfterRestart.finalizedAt).toBeTruthy();
    expect(intakeAfterRestart.finalizedByAdminUserId).toBe("admin-4");

    const photoRows = await dbSecond.select().from(schema.productPhotos).where(eq(schema.productPhotos.productId, productId));
    expect(photoRows).toHaveLength(1);
    expect(photoRows[0].id).toBe(photo.id);
    expect(Boolean(photoRows[0].isPrimary)).toBe(true);
    const primaryCount = photoRows.filter((row: any) => Boolean(row.isPrimary)).length;
    expect(primaryCount).toBe(1);

    const outboxRows = await dbSecond.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.aggregateId, photo.id));
    expect(outboxRows.some((row: any) => row.eventType === "product_photo.promote_requested")).toBe(true);

    const stagedRowsAfterRestart = await listIntakePhotos(dbSecond, intake.id);
    expect(stagedRowsAfterRestart).toHaveLength(1);
    expect(stagedRowsAfterRestart[0].id).toBe(photo.id);
    expect(stagedRowsAfterRestart[0].storageKey).toBe(photo.storageKey);

    // Real files on disk: the original staged source, and the deterministic canonical main +
    // thumbnail files - all written by the FIRST run, all still present after the restart.
    expect(existsSync(path.join(stagedPhotoTempDir, photo.storageKey))).toBe(true);
    const mainKey = photoRows[0].storageKey as string;
    const thumbKey = photoRows[0].thumbnailStorageKey as string;
    expect(existsSync(path.join(canonicalPhotoTempDir, mainKey))).toBe(true);
    expect(existsSync(path.join(canonicalPhotoTempDir, thumbKey))).toBe(true);

    await second.shutdown();
  });
});
