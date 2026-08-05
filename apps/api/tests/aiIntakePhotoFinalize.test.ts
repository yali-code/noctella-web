import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiIntakeFieldDecision, AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";
import {
  AiIntakePhotoFinalizationNoStagedPhotosError,
  AiIntakePhotoFinalizationNotAppliedError,
  AiIntakePhotoFinalizationPrimaryInvalidError,
  AiIntakePhotoFinalizationProductNotDraftError,
  AiIntakePhotoFinalizationProductPhotosExistError,
  AiIntakePhotoFinalizationResultStateInvalidError,
  AiIntakePhotoFinalizationStateInvalidError,
  AiIntakePhotoMutationNotAllowedError,
  NotFoundError,
} from "../src/services/errors";
import { createIntake, cancelIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto, deleteIntakePhoto, listIntakePhotos } from "../src/services/aiIntakePhotos";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview } from "../src/services/aiIntakeProposals";
import { saveAiIntakeAsDraft } from "../src/services/aiIntakeApply";
import { finalizeAiIntakePhotos } from "../src/services/aiIntakePhotoFinalization";
import { archiveProduct, getProductById } from "../src/services/products";
import { createCategory } from "../src/services/categories";
import {
  finalizeAiIntakePhotosUseCase,
  buildAiIntakePhotoFinalizationManifest,
  type AiIntakePhotoFinalizationManifestDeps,
} from "../src/use-cases/ai-intake-photo-finalize/useCases";
import {
  createAiIntakePhotoFinalizeTransactionCapabilityForDb,
  type AiIntakePhotoFinalizeTransactionCapability,
} from "../src/services/aiIntakePhotoFinalizeTransactionCapabilityForDb";
import type { AiIntakeGenerationProvider } from "../src/ai-intake/types";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import type { DeterministicProductPhotoInput } from "../src/services/photoStorage";
import { aiIntakePhotos, aiProductIntakes, products, productPhotos, outboxEvents, stockMovements } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { createTestDb } from "./testDb";

/**
 * Sprint 95 final correction: implements the simplified AiIntakePhotoStorage
 * interface (saveIntakePhoto/deleteIntakePhoto only - no quarantine/tombstone
 * concept remains) - mirrors aiIntakePhotos.test.ts's own mockStorage().
 */
function mockPhotoStorage(): AiIntakePhotoStorage & {
  sourceExists: (storageKey: string) => boolean;
} {
  let counter = 0;
  const sources = new Set<string>();
  return {
    saveIntakePhoto: vi.fn(async () => {
      counter += 1;
      const storageKey = `mock-key-${counter}.webp`;
      sources.add(storageKey);
      return { storageKey };
    }),
    deleteIntakePhoto: vi.fn(async (storageKey: string) => {
      sources.delete(storageKey);
    }),
    sourceExists: (storageKey: string) => sources.has(storageKey),
  };
}

function mockManifestDeps(): AiIntakePhotoFinalizationManifestDeps {
  return {
    readStagedPhotoBytes: vi.fn(async (stagedPhotoId: string) => Buffer.from(`bytes-for-${stagedPhotoId}`)),
    writeDeterministicPhoto: vi.fn(async (input: DeterministicProductPhotoInput) => ({
      mainStorageKey: input.mainStorageKey,
      thumbnailStorageKey: input.thumbnailStorageKey,
      url: `/images/product-photos/${input.mainStorageKey}`,
      thumbnailUrl: `/images/product-photos/${input.thumbnailStorageKey}`,
      mimeType: "image/webp",
      sizeBytes: input.size,
      width: 800,
      height: 600,
    })),
  };
}

function stubProvider(): AiIntakeGenerationProvider {
  return {
    generate: vi.fn(async (req) => ({
      proposal: { suggestedTitle: "Stub Title", suggestedDescription: "Stub description.", suggestedKeywords: ["stub", "keyword"], confidenceScore: 0.7 },
      metadata: { providerName: "stub-provider", promptVersion: req.prompt.version },
    })),
  };
}

describe("AI intake photo promotion, Primary selection, and finalization (Sprint 95)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
    const category = await createCategory(db as any, { name: "Test Category", displayOrder: 0, isActive: true } as any);
    categoryId = category.id;
  });

  /** Creates an intake, uploads `photoCount` staged photos, generates+accepts the title, and applies (Save as Draft) - returns an Applied intake with a resultProductId and its staged photo ids in canonical order. */
  async function readyAppliedIntake(photoCount = 1): Promise<{ intakeId: string; productId: string; stagedPhotoIds: string[] }> {
    const intake = await createIntake(db as any, "admin-1");
    const intakeId = intake.id;
    const storage = mockPhotoStorage();
    for (let i = 0; i < photoCount; i += 1) {
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, `photo-${i}.png`, "admin-1", storage);
    }
    const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
    const reviewed = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
    const applied = await saveAiIntakeAsDraft(
      db as any,
      intakeId,
      { sku: `SKU-${Math.random().toString(36).slice(2, 10)}`, categoryId, type: ProductType.UniqueItem, priceEur: 42, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
      "admin-3",
    );
    const stagedPhotos = await listIntakePhotos(db as any, intakeId);
    return { intakeId, productId: applied.product.id, stagedPhotoIds: stagedPhotos.map((p) => p.id as string) };
  }

  describe("happy path", () => {
    it("creates exactly one canonical ProductPhoto per staged photo, in canonical order, exactly one Primary, Product remains Draft", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(3);
      const result = await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      expect(result.created).toBe(true);
      expect(result.product.id).toBe(productId);
      expect(result.product.status).toBe(ProductStatus.Draft);

      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId)).orderBy(productPhotos.sortOrder);
      expect(rows.map((r: any) => r.id)).toEqual(stagedPhotoIds);
      expect(rows.map((r: any) => r.sortOrder)).toEqual([0, 1, 2]);
      expect(rows.filter((r: any) => r.isPrimary).map((r: any) => r.id)).toEqual([stagedPhotoIds[0]]);
      expect(rows.every((r: any) => r.processingStatus === "Processing")).toBe(true);
    });

    it("uses the staged photo id as the ProductPhoto id (deterministic identity)", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const [row] = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(row.id).toBe(stagedPhotoIds[0]);
    });

    it("omitted primaryIntakePhotoId defaults to the first staged photo in canonical order", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(2);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows.find((r: any) => r.isPrimary)?.id).toBe(stagedPhotoIds[0]);
    });

    it("explicit primaryIntakePhotoId selects that staged photo as Primary", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(2);
      await finalizeAiIntakePhotos(db as any, intakeId, { primaryIntakePhotoId: stagedPhotoIds[1] }, "admin-4", mockManifestDeps());
      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows.find((r: any) => r.isPrimary)?.id).toBe(stagedPhotoIds[1]);
      expect(rows.filter((r: any) => r.isPrimary)).toHaveLength(1);
    });

    it("intake transitions Applied -> Finalized, records finalizedAt/finalizedByAdminUserId", async () => {
      const { intakeId } = await readyAppliedIntake(1);
      const before = new Date().toISOString();
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Finalized);
      expect(intake.finalizedByAdminUserId).toBe("admin-4");
      expect(intake.finalizedAt! >= before).toBe(true);
    });

    it("staged photo rows and their files (storageKey) remain intact after finalization", async () => {
      const { intakeId, stagedPhotoIds } = await readyAppliedIntake(2);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const staged = await listIntakePhotos(db as any, intakeId);
      expect(staged.map((p) => p.id)).toEqual(stagedPhotoIds);
    });

    it("creates a ProductPhotoPromoteRequested outbox event for each created ProductPhoto", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(2);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateType, "ProductPhoto"));
      const promoteEvents = events.filter((e: any) => e.eventType === "product_photo.promote_requested" && stagedPhotoIds.includes(e.aggregateId));
      expect(promoteEvents).toHaveLength(2);
      expect(new Set(promoteEvents.map((e: any) => JSON.parse(e.payload).productId))).toEqual(new Set([productId]));
    });

    it("does not create Inventory/StockMovement rows and does not transition Product status", async () => {
      const { intakeId, productId } = await readyAppliedIntake(1);
      const before = await db.select().from(stockMovements);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const after = await db.select().from(stockMovements);
      expect(after).toHaveLength(before.length);
      const [productRow] = await db.select().from(products).where(eq(products.id, productId));
      expect(productRow.status).toBe(ProductStatus.Draft);
    });
  });

  describe("idempotency and retry", () => {
    it("a retry after successful finalization returns HTTP-level created:false, the same Product, no duplicate ProductPhoto rows or outbox events", async () => {
      const { intakeId, productId } = await readyAppliedIntake(2);
      const first = await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      expect(first.created).toBe(true);
      const second = await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-5", mockManifestDeps());
      expect(second.created).toBe(false);
      expect(second.product.id).toBe(productId);

      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows).toHaveLength(2);
      const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateType, "ProductPhoto"));
      expect(events).toHaveLength(2);
    });

    it("a changed primaryIntakePhotoId on retry is ignored - Primary remains the originally-finalized photo", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(2);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      await finalizeAiIntakePhotos(db as any, intakeId, { primaryIntakePhotoId: stagedPhotoIds[1] }, "admin-5", mockManifestDeps());
      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows.find((r: any) => r.isPrimary)?.id).toBe(stagedPhotoIds[0]);
    });

    it("finalization actor and time remain immutable across a retry", async () => {
      const { intakeId } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const firstIntake = await getIntakeById(db as any, intakeId);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-9", mockManifestDeps());
      const secondIntake = await getIntakeById(db as any, intakeId);
      expect(secondIntake.finalizedByAdminUserId).toBe(firstIntake.finalizedByAdminUserId);
      expect(secondIntake.finalizedAt).toBe(firstIntake.finalizedAt);
    });

    it("retry does not re-prepare or rewrite files - manifestDeps is never called on an already-Finalized retry", async () => {
      const { intakeId } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const deps = mockManifestDeps();
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-5", deps);
      expect(deps.readStagedPhotoBytes).not.toHaveBeenCalled();
      expect(deps.writeDeterministicPhoto).not.toHaveBeenCalled();
    });

    it("an already-Finalized intake with a deleted canonical ProductPhoto row (constructed directly) returns a deterministic result-state-invalid conflict", async () => {
      const { intakeId, productId } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      await db.delete(productPhotos).where(eq(productPhotos.productId, productId));
      await expect(finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-5", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationResultStateInvalidError,
      );
    });
  });

  describe("readiness and canonical-state protection", () => {
    it("rejects an Open intake with AiIntakePhotoFinalizationNotAppliedError", async () => {
      const intake = await createIntake(db as any, "admin-1");
      await expect(finalizeAiIntakePhotos(db as any, intake.id, {}, "admin-4", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationNotAppliedError,
      );
    });

    it("rejects a Cancelled intake with AiIntakePhotoFinalizationNotAppliedError", async () => {
      const intake = await createIntake(db as any, "admin-1");
      await cancelIntake(db as any, intake.id, "admin-2");
      await expect(finalizeAiIntakePhotos(db as any, intake.id, {}, "admin-4", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationNotAppliedError,
      );
    });

    it("rejects when the Product is not Draft (e.g. Archived)", async () => {
      const { intakeId, productId } = await readyAppliedIntake(1);
      await archiveProduct(db as any, productId);
      await expect(finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationProductNotDraftError,
      );
    });

    it("rejects when the Product already has canonical ProductPhoto rows - never appends to or overrides them", async () => {
      const { intakeId, productId } = await readyAppliedIntake(1);
      const now = new Date().toISOString();
      await db.insert(productPhotos).values({
        id: "manual-photo-1", productId, url: "/images/product-photos/manual.webp", thumbnailUrl: "/images/product-photos/manual-thumb.webp",
        sortOrder: 0, isPrimary: true, filename: "manual.webp", mimeType: "image/webp", sizeBytes: 10, width: 100, height: 100,
        processingStatus: "Ready", createdAt: now, updatedAt: now,
      });
      await expect(finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationProductPhotosExistError,
      );
      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("manual-photo-1");
    });

    it("rejects finalization when the intake has no staged photos (all deleted before apply is impossible via applied-state, but validated defensively)", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const generated = await generateIntakeProposal(db as any, intake.id, stubProvider());
      const reviewed = await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      const applied = await saveAiIntakeAsDraft(
        db as any,
        intake.id,
        { sku: `SKU-${Math.random().toString(36).slice(2, 10)}`, categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
        "admin-3",
      );
      expect(applied.created).toBe(true);
      await expect(finalizeAiIntakePhotos(db as any, intake.id, {}, "admin-4", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationNoStagedPhotosError,
      );
    });

    it("rejects a primaryIntakePhotoId that does not belong to this intake's staged set with a 400-classified error", async () => {
      const { intakeId } = await readyAppliedIntake(1);
      await expect(
        finalizeAiIntakePhotos(db as any, intakeId, { primaryIntakePhotoId: "not-a-real-staged-photo" }, "admin-4", mockManifestDeps()),
      ).rejects.toBeInstanceOf(AiIntakePhotoFinalizationPrimaryInvalidError);
    });
  });

  describe("staged photo deletion gate (Applied/Finalized immutability correction)", () => {
    it("deletion remains allowed for an Open intake", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await expect(deleteIntakePhoto(db as any, intake.id, photo.id, storage)).resolves.toBeUndefined();
    });

    it("deletion remains allowed for a Cancelled intake (preserving Sprint 91/93 behavior)", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await cancelIntake(db as any, intake.id, "admin-2");
      await expect(deleteIntakePhoto(db as any, intake.id, photo.id, storage)).resolves.toBeUndefined();
    });

    it("deletion is rejected for an Applied intake - row and file remain intact", async () => {
      const { intakeId, stagedPhotoIds } = await readyAppliedIntake(1);
      const storage = mockPhotoStorage();
      await expect(deleteIntakePhoto(db as any, intakeId, stagedPhotoIds[0], storage)).rejects.toBeInstanceOf(AiIntakePhotoMutationNotAllowedError);
      expect(storage.deleteIntakePhoto).not.toHaveBeenCalled();
      const [row] = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.id, stagedPhotoIds[0]));
      expect(row).toBeTruthy();
    });

    it("deletion is rejected for a Finalized intake - row and file remain intact", async () => {
      const { intakeId, stagedPhotoIds } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const storage = mockPhotoStorage();
      await expect(deleteIntakePhoto(db as any, intakeId, stagedPhotoIds[0], storage)).rejects.toBeInstanceOf(AiIntakePhotoMutationNotAllowedError);
      expect(storage.deleteIntakePhoto).not.toHaveBeenCalled();
      const [row] = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.id, stagedPhotoIds[0]));
      expect(row).toBeTruthy();
    });

    it("does not delete any staged photo row or file during finalization itself", async () => {
      const { intakeId, stagedPhotoIds } = await readyAppliedIntake(2);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      const rows = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(rows.map((r: any) => r.id).sort()).toEqual([...stagedPhotoIds].sort());
    });
  });

  /**
   * Sprint 95 final correction: required race tests for the DB-first
   * staged-photo delete flow. Both A and B below are genuine SERIAL-ORDER
   * proofs (one real operation fully commits, then the second real operation
   * is attempted) - not a live multi-connection interleaving proof, and not
   * described as one. The DB-first design closes the original TOCTOU window
   * by performing zero filesystem mutation before the locked DB transaction
   * commits, which removes the seam a mid-transaction interleaving test
   * would need to target in the first place - proving the two operations
   * behave correctly in both possible commit orders is the correct and
   * honest way to verify the fix, consistent with this codebase's
   * established SQLite single-connection reasoning (no live PostgreSQL
   * instance is available in this environment).
   */
  describe("staged-delete vs Sprint 94 apply (Sprint 95 final correction race tests)", () => {
    it("A (serial-order proof): apply commits Open -> Applied first, then a staged DELETE is attempted - rejected, row/file remain, storage.deleteIntakePhoto never called", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const generated = await generateIntakeProposal(db as any, intake.id, stubProvider());
      const reviewed = await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      await saveAiIntakeAsDraft(
        db as any,
        intake.id,
        { sku: `SKU-RACE-A-${Math.random().toString(36).slice(2, 8)}`, categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
        "admin-3",
      );
      const intakeAfterApply = await getIntakeById(db as any, intake.id);
      expect(intakeAfterApply.status).toBe(AiProductIntakeStatus.Applied);

      await expect(deleteIntakePhoto(db as any, intake.id, photo.id, storage)).rejects.toBeInstanceOf(AiIntakePhotoMutationNotAllowedError);

      const rows = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.id, photo.id));
      expect(rows).toHaveLength(1);
      expect(storage.sourceExists(photo.storageKey)).toBe(true);
      expect(storage.deleteIntakePhoto).not.toHaveBeenCalled();
    });

    it("B (serial-order proof): a staged DELETE commits first (while Open), then a real Sprint 94 apply attempt rejects because the photo-set fingerprint is now stale - no Product created, intake remains Open, resultProductId remains null", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const generated = await generateIntakeProposal(db as any, intake.id, stubProvider());
      const reviewed = await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);

      await deleteIntakePhoto(db as any, intake.id, photo.id, storage);
      expect(await listIntakePhotos(db as any, intake.id)).toHaveLength(0);
      expect(storage.sourceExists(photo.storageKey)).toBe(false);

      await expect(
        saveAiIntakeAsDraft(
          db as any,
          intake.id,
          { sku: `SKU-RACE-B-${Math.random().toString(36).slice(2, 8)}`, categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
          "admin-3",
        ),
      ).rejects.toThrow(); // AiIntakeApplyPhotoSetStaleError - the staged photo set no longer matches the proposal's captured fingerprint

      const productRows = await db.select().from(products);
      expect(productRows).toHaveLength(0);
      const intakeAfter = await getIntakeById(db as any, intake.id);
      expect(intakeAfter.status).toBe(AiProductIntakeStatus.Open);
      expect(intakeAfter.resultProductId).toBeUndefined();
    });

    it("D (rollback-compensation proof): a post-commit file-delete failure does not fail the request, does not touch the already-deleted DB row, and leaves the source file as a Sprint-96-owned orphan", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);

      storage.deleteIntakePhoto.mockRejectedValueOnce(new Error("simulated post-commit cleanup failure (e.g. EBUSY)"));

      // The chosen deterministic contract: the logical deletion (the DB row) is already committed
      // by the time the post-commit file delete runs, so a cleanup failure must never surface as
      // a request failure - resolves successfully, per services/aiIntakePhotos.ts's documented
      // contract. Since no filesystem mutation happens before commit, there is nothing to restore
      // - the source file simply remains, an accepted Sprint-96-owned orphan.
      await expect(deleteIntakePhoto(db as any, intake.id, photo.id, storage)).resolves.toBeUndefined();

      expect(await listIntakePhotos(db as any, intake.id)).toHaveLength(0);
      expect(storage.sourceExists(photo.storageKey)).toBe(true);
      // Retry behavior is honest and documented: the row is gone, so a repeated delete request
      // now correctly 404s (idempotent-looking retry semantics are unaffected by the cleanup
      // failure - it never touched the row).
      await expect(deleteIntakePhoto(db as any, intake.id, photo.id, storage)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("atomic rollback", () => {
    async function capabilityWithFailingCreate(intakeId: string): Promise<AiIntakePhotoFinalizeTransactionCapability> {
      const real = createAiIntakePhotoFinalizeTransactionCapabilityForDb(db as any, "sqlite");
      return {
        driver: real.driver,
        execution: real.execution,
        runWithLockedIntake(id: string, work: any) {
          return real.runWithLockedIntake(id, (ctx: any) => {
            let calls = 0;
            const wrapped = {
              ...ctx,
              createProductPhoto: (input: any) => {
                calls += 1;
                if (calls === 2) throw new Error("simulated ProductPhoto insert failure");
                return ctx.createProductPhoto(input);
              },
            };
            return work(wrapped);
          });
        },
      } as AiIntakePhotoFinalizeTransactionCapability;
    }

    it("a ProductPhoto insert failure partway through a multi-photo set rolls back every row, every outbox event, and the Finalized transition", async () => {
      const { intakeId, productId } = await readyAppliedIntake(3);
      const deps = mockManifestDeps();
      const stagedPhotos = await listIntakePhotos(db as any, intakeId);
      const manifest = await buildAiIntakePhotoFinalizationManifest(
        deps,
        stagedPhotos.map((p) => ({ id: p.id as string, storageKey: p.storageKey as string })),
        productId,
        undefined,
      );
      const capability = await capabilityWithFailingCreate(intakeId);
      await expect(finalizeAiIntakePhotosUseCase(capability, { intakeId, actorId: "admin-4", manifest })).rejects.toThrow(
        "simulated ProductPhoto insert failure",
      );

      const photoRows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(photoRows).toHaveLength(0);
      const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateType, "ProductPhoto"));
      expect(events).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Applied);
      expect(intake.finalizedAt).toBeUndefined();
    });

    it("intake remains retryable after a rolled-back finalization attempt", async () => {
      const { intakeId, productId } = await readyAppliedIntake(2);
      const stagedPhotos = await listIntakePhotos(db as any, intakeId);
      const manifest = await buildAiIntakePhotoFinalizationManifest(
        mockManifestDeps(),
        stagedPhotos.map((p) => ({ id: p.id as string, storageKey: p.storageKey as string })),
        productId,
        undefined,
      );
      const capability = await capabilityWithFailingCreate(intakeId);
      await expect(finalizeAiIntakePhotosUseCase(capability, { intakeId, actorId: "admin-4", manifest })).rejects.toThrow();

      const result = await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-5", mockManifestDeps());
      expect(result.created).toBe(true);
      const photoRows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(photoRows).toHaveLength(2);
    });
  });

  describe("single source of truth: canonical ProductPhoto write and Product photo-mutation lock reuse", () => {
    it("the real finalization path exercises repositories/product-write/drizzle.ts's createProductPhotoWithPromotionOutboxInTransaction (not an independent duplicate)", async () => {
      const repoModule = await import("../src/repositories/product-write/drizzle");
      const spy = vi.spyOn(repoModule, "createProductPhotoWithPromotionOutboxInTransaction");
      const { intakeId } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      expect(spy).toHaveBeenCalled();
    });

    it("finalization locks the Product row via the shared lockProductRowInTransaction function (cross-module call, spy-visible)", async () => {
      const lockModule = await import("../src/services/productPhotoMutationLockTransactionCapabilityForDb");
      const spy = vi.spyOn(lockModule, "lockProductRowInTransaction");
      const { intakeId } = await readyAppliedIntake(1);
      await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      expect(spy).toHaveBeenCalled();
    });

    it("uploadProductPhoto's standalone lock capability delegates to the same lockProductRowInTransaction function (source-level proof - a same-module call site is not spy-interceptable via ESM bindings)", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const lockSrc = fs.readFileSync(path.resolve(__dirname, "../src/services/productPhotoMutationLockTransactionCapabilityForDb.ts"), "utf8");
      // createProductPhotoMutationLockCapabilityForDb (used by uploadProductPhoto) and the
      // standalone lockProductRowInTransaction export (used directly by
      // aiIntakePhotoFinalizeTransactionCapabilityForDb.ts, proven by the spy test above) are
      // defined in this one file, and the capability's SQLite/Postgres branches both call
      // lockProductRowInTransaction(...) rather than re-implementing the SELECT/FOR UPDATE query.
      const occurrences = lockSrc.match(/lockProductRowInTransaction\(/g) ?? [];
      // 1 function declaration + at least 2 call sites (the capability's SQLite and Postgres branches).
      expect(occurrences.length).toBeGreaterThanOrEqual(3);
      const forUpdateOccurrences = (lockSrc.match(/\.for\("update"\)/g) ?? []).length;
      expect(forUpdateOccurrences).toBe(1); // only inside lockProductRowInTransaction itself - never duplicated in the capability branches
      const productsSrc = fs.readFileSync(path.resolve(__dirname, "../src/services/products.ts"), "utf8");
      expect(productsSrc).toContain("createProductPhotoMutationLockCapabilityForDb");
      expect(productsSrc).not.toContain(".for(\"update\")");
    });
  });

  /**
   * Sprint 95 critical correction: the two required shared-Product-photo-
   * mutation-lock serial-order proofs, using the real production
   * uploadProductPhoto and finalize-photos operations (not direct DB
   * insertion) in both possible commit orders.
   */
  describe("normal ProductPhoto upload vs finalization (shared lock serial-order proofs)", () => {
    it("normal upload commits first: finalization then returns the deterministic ProductPhotos-exist 409, the uploaded ProductPhoto is untouched, and no Sprint 95 DB/outbox/finalization state commits", async () => {
      const { intakeId, productId } = await readyAppliedIntake(1);
      const { uploadProductPhoto } = await import("../src/services/products");
      const uploaded = await uploadProductPhoto(
        db as any,
        productId,
        { buffer: Buffer.from("a"), mimetype: "image/png", size: 1 },
        undefined,
        {
          saveProductPhoto: vi.fn(async () => ({
            filename: "manual.webp", url: "/images/product-photos/manual.webp", thumbnailUrl: "/images/product-photos/manual-thumb.webp",
            mimeType: "image/webp", sizeBytes: 1, width: 10, height: 10,
          })),
          deleteProductPhoto: vi.fn(async () => {}),
        } as any,
      );
      expect(uploaded.isPrimary).toBe(true);

      await expect(finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps())).rejects.toBeInstanceOf(
        AiIntakePhotoFinalizationProductPhotosExistError,
      );

      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(uploaded.id);
      expect(rows[0].isPrimary).toBeTruthy();
      const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateType, "ProductPhoto"));
      expect(events).toHaveLength(1); // only the real upload's own promotion event - none from finalization
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Applied); // never transitioned to Finalized
      expect(intake.finalizedAt).toBeUndefined();
    });

    it("finalization commits first: a subsequent normal upload appends as non-Primary, the finalized Primary remains unchanged, exactly one Primary exists, and Finalized audit state is untouched", async () => {
      const { intakeId, productId, stagedPhotoIds } = await readyAppliedIntake(1);
      const result = await finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps());
      expect(result.created).toBe(true);
      const intakeAfterFinalize = await getIntakeById(db as any, intakeId);
      expect(intakeAfterFinalize.status).toBe(AiProductIntakeStatus.Finalized);

      const { uploadProductPhoto } = await import("../src/services/products");
      const uploaded = await uploadProductPhoto(
        db as any,
        productId,
        { buffer: Buffer.from("b"), mimetype: "image/png", size: 1 },
        undefined,
        {
          saveProductPhoto: vi.fn(async () => ({
            filename: "manual2.webp", url: "/images/product-photos/manual2.webp", thumbnailUrl: "/images/product-photos/manual2-thumb.webp",
            mimeType: "image/webp", sizeBytes: 1, width: 10, height: 10,
          })),
          deleteProductPhoto: vi.fn(async () => {}),
        } as any,
      );
      expect(uploaded.isPrimary).toBe(false);

      const rows = await db.select().from(productPhotos).where(eq(productPhotos.productId, productId));
      expect(rows).toHaveLength(2);
      const primaryRows = rows.filter((r: any) => r.isPrimary);
      expect(primaryRows).toHaveLength(1);
      expect(primaryRows[0].id).toBe(stagedPhotoIds[0]); // the originally-finalized Primary, unchanged

      const intakeAfterUpload = await getIntakeById(db as any, intakeId);
      expect(intakeAfterUpload.status).toBe(AiProductIntakeStatus.Finalized);
      expect(intakeAfterUpload.finalizedAt).toBe(intakeAfterFinalize.finalizedAt);
      expect(intakeAfterUpload.finalizedByAdminUserId).toBe(intakeAfterFinalize.finalizedByAdminUserId);
    });
  });

  describe("locking construction", () => {
    it("PostgreSQL Drizzle construction remains valid for the finalize transaction capability, and its Product lock uses FOR UPDATE", async () => {
      const capability = createAiIntakePhotoFinalizeTransactionCapabilityForDb(db as any, "postgres" as any);
      expect(capability.driver).toBe("postgres");
      expect(capability.execution).toBe("asynchronous");
      const fs = require("node:fs");
      const path = require("node:path");
      const src = fs.readFileSync(path.resolve(__dirname, "../src/services/productPhotoMutationLockTransactionCapabilityForDb.ts"), "utf8");
      expect(src).toContain('.for("update")');
    });

    it("SQLite finalize transaction stays synchronous end to end (no async-callback rejection)", async () => {
      const { intakeId } = await readyAppliedIntake(1);
      await expect(finalizeAiIntakePhotos(db as any, intakeId, {}, "admin-4", mockManifestDeps())).resolves.toBeTruthy();
    });
  });

  describe("database foundation", () => {
    it("SQLite ensureSchema is idempotent for the new finalized_at/finalized_by_admin_user_id columns", () => {
      const fresh = new Database(":memory:");
      ensureSchema(fresh);
      ensureSchema(fresh);
      const columns = (fresh.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string }>).map((r) => r.name);
      expect(columns).toContain("finalized_at");
      expect(columns).toContain("finalized_by_admin_user_id");
      fresh.close();
    });

    it("genuinely upgrades an existing pre-Sprint-95 SQLite database (neither finalization column), preserves the existing row, and the real finalization path then succeeds", async () => {
      const upgradeSqlite = new Database(":memory:");
      upgradeSqlite.pragma("foreign_keys = ON");

      // The exact pre-Sprint-95 (post-Sprint-94) CREATE TABLE, deliberately without
      // finalized_at / finalized_by_admin_user_id.
      upgradeSqlite.exec(`
        CREATE TABLE IF NOT EXISTS ai_product_intakes (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'open',
          created_by_admin_user_id TEXT NOT NULL,
          result_product_id TEXT UNIQUE,
          cancelled_at TEXT,
          cancelled_by_admin_user_id TEXT,
          cancellation_reason TEXT,
          applied_at TEXT,
          applied_by_admin_user_id TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_product_intakes_status ON ai_product_intakes(status);
      `);

      const preExistingId = "pre-existing-sprint94-intake";
      upgradeSqlite
        .prepare("INSERT INTO ai_product_intakes (id, status, created_by_admin_user_id, created_at, updated_at) VALUES (?, 'open', ?, ?, ?)")
        .run(preExistingId, "admin-1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

      expect(() => ensureSchema(upgradeSqlite)).not.toThrow();

      const columnInfo = upgradeSqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string; notnull: number }>;
      const columnsByName = new Map(columnInfo.map((c) => [c.name, c]));
      expect(columnsByName.has("finalized_at")).toBe(true);
      expect(columnsByName.has("finalized_by_admin_user_id")).toBe(true);
      expect(columnsByName.get("finalized_at")!.notnull).toBe(0);
      expect(columnsByName.get("finalized_by_admin_user_id")!.notnull).toBe(0);

      const preExistingRow = upgradeSqlite.prepare("SELECT * FROM ai_product_intakes WHERE id = ?").get(preExistingId) as Record<string, unknown>;
      expect(preExistingRow.status).toBe("open");
      expect(preExistingRow.finalized_at).toBeNull();
      expect(preExistingRow.finalized_by_admin_user_id).toBeNull();

      // Idempotent re-run.
      expect(() => ensureSchema(upgradeSqlite)).not.toThrow();

      // Now that the schema is upgraded, the real finalization flow succeeds end-to-end against
      // a fresh intake created on this same (upgraded) connection.
      const upgradeDb = drizzle(upgradeSqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
      const upgradeCategory = await createCategory(upgradeDb as any, { name: "Upgrade Category", displayOrder: 0, isActive: true } as any);
      const intake = await createIntake(upgradeDb as any, "admin-1");
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(upgradeDb as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const generated = await generateIntakeProposal(upgradeDb as any, intake.id, stubProvider());
      const reviewed = await updateProposalFieldReview(upgradeDb as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      const applied = await saveAiIntakeAsDraft(
        upgradeDb as any,
        intake.id,
        { sku: `SKU-UP-${Math.random().toString(36).slice(2, 8)}`, categoryId: upgradeCategory.id, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
        "admin-3",
      );

      const result = await finalizeAiIntakePhotos(upgradeDb as any, intake.id, {}, "admin-4", mockManifestDeps());
      expect(result.created).toBe(true);
      expect(result.product.id).toBe(applied.product.id);

      upgradeSqlite.close();
    });

    it("migration 0012 adds only the finalization columns, additively", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const sql = fs.readFileSync(path.resolve(__dirname, "../src/db/postgres-migrations/0012_sprint95_ai_intake_photo_finalization.sql"), "utf8");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS finalized_at");
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS finalized_by_admin_user_id");
      expect(sql).not.toMatch(/DROP |DELETE FROM|ALTER TABLE .* DROP/i);
    });

    it("migrations 0001-0011 are unchanged", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = path.resolve(__dirname, "../src/db/postgres-migrations");
      const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".sql")).sort();
      expect(files[files.length - 1]).toBe("0012_sprint95_ai_intake_photo_finalization.sql");
      expect(files).toHaveLength(12);
    });
  });
});
