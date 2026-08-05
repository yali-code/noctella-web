import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AiProductIntakeStatus, AdminRole, AiIntakeFieldDecision, ProductType } from "@noctella/shared";
import { ROLE_PERMISSIONS } from "@noctella/shared";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import { cancelIntake, createIntake, getIntakeById, listIntakes } from "../src/services/aiProductIntakes";
import { createAiProductIntakeRepository } from "../src/repositories/ai-product-intake/factory";
import { createDrizzleAiProductIntakeRepository } from "../src/repositories/ai-product-intake/drizzle";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { aiProductIntakes, products, productImages, productPhotos, stockMovements, publishJobs, externalListings } from "../src/db/schema";
import { ensureSchema } from "../src/db/migrate";
import { requiredSprint24Tables, runSchemaParity, validatePostgresMigrationSql } from "../src/services/databaseMigrationFoundation";
import { MockAiListingProvider } from "../src/ai/mockProvider";
import { createTestDb } from "./testDb";
import { createCategory } from "../src/services/categories";
import { uploadIntakePhoto } from "../src/services/aiIntakePhotos";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview } from "../src/services/aiIntakeProposals";
import { saveAiIntakeAsDraft } from "../src/services/aiIntakeApply";
import { finalizeAiIntakePhotos } from "../src/services/aiIntakePhotoFinalization";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("ai product intake foundation (Sprint 90)", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("create", () => {
    it("creates an Open intake with the authenticated creator recorded", async () => {
      const intake = await createIntake(db as any, "admin-1");
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
      expect(intake.createdByAdminUserId).toBe("admin-1");
    });

    it("resultProductId is null on creation", async () => {
      const intake = await createIntake(db as any, "admin-1");
      expect(intake.resultProductId).toBeUndefined();
    });

    it("cancellation fields are null on creation", async () => {
      const intake = await createIntake(db as any, "admin-1");
      expect(intake.cancelledAt).toBeUndefined();
      expect(intake.cancelledByAdminUserId).toBeUndefined();
      expect(intake.cancellationReason).toBeUndefined();
    });

    it("does not create a Product, ProductPhoto, ProductImage, or stock movement row", async () => {
      await createIntake(db as any, "admin-1");
      await createIntake(db as any, "admin-2");
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(productPhotos)).toHaveLength(0);
      expect(await db.select().from(productImages)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
    });

    it("does not invoke an AI provider", async () => {
      const spy = vi.spyOn(MockAiListingProvider.prototype, "generateListing");
      await createIntake(db as any, "admin-1");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("does not create a publish job or external listing (no marketplace/publishing side effect)", async () => {
      await createIntake(db as any, "admin-1");
      expect(await db.select().from(publishJobs)).toHaveLength(0);
      expect(await db.select().from(externalListings)).toHaveLength(0);
    });
  });

  describe("get", () => {
    it("returns an existing intake", async () => {
      const created = await createIntake(db as any, "admin-1");
      const fetched = await getIntakeById(db as any, created.id);
      expect(fetched).toEqual(created);
    });

    it("throws NotFoundError for a nonexistent intake", async () => {
      await expect(getIntakeById(db as any, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("list", () => {
    it("applies default pagination", async () => {
      for (let i = 0; i < 3; i++) await createIntake(db as any, `admin-${i}`);
      const result = await listIntakes(db as any, { page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it("applies explicit pagination", async () => {
      for (let i = 0; i < 5; i++) await createIntake(db as any, `admin-${i}`);
      const page1 = await listIntakes(db as any, { page: 1, pageSize: 2 });
      const page2 = await listIntakes(db as any, { page: 2, pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
    });

    it("filters by status", async () => {
      const a = await createIntake(db as any, "admin-1");
      await createIntake(db as any, "admin-2");
      await cancelIntake(db as any, a.id, "admin-1");

      const openOnly = await listIntakes(db as any, { page: 1, pageSize: 20, status: AiProductIntakeStatus.Open });
      const cancelledOnly = await listIntakes(db as any, { page: 1, pageSize: 20, status: AiProductIntakeStatus.Cancelled });
      expect(openOnly.items).toHaveLength(1);
      expect(cancelledOnly.items).toHaveLength(1);
      expect(cancelledOnly.items[0].id).toBe(a.id);
    });
  });

  describe("cancellation", () => {
    it("transitions Open to Cancelled and records the actor, reason, and advances updatedAt", async () => {
      const created = await createIntake(db as any, "admin-1");
      await new Promise((resolve) => setTimeout(resolve, 2));
      const cancelled = await cancelIntake(db as any, created.id, "admin-2", "no longer needed");

      expect(cancelled.status).toBe(AiProductIntakeStatus.Cancelled);
      expect(cancelled.cancelledByAdminUserId).toBe("admin-2");
      expect(cancelled.cancellationReason).toBe("no longer needed");
      expect(cancelled.cancelledAt).toBeTruthy();
      expect(cancelled.updatedAt).not.toBe(created.updatedAt);
    });

    it("a repeated cancel returns 200-equivalent success and preserves the original actor/time/reason", async () => {
      const created = await createIntake(db as any, "admin-1");
      const first = await cancelIntake(db as any, created.id, "admin-2", "first reason");
      const second = await cancelIntake(db as any, created.id, "admin-3", "second reason should not apply");

      expect(second.status).toBe(AiProductIntakeStatus.Cancelled);
      expect(second.cancelledByAdminUserId).toBe(first.cancelledByAdminUserId);
      expect(second.cancelledAt).toBe(first.cancelledAt);
      expect(second.cancellationReason).toBe(first.cancellationReason);
      expect(second.cancellationReason).not.toBe("second reason should not apply");
    });

    it("throws NotFoundError when cancelling a nonexistent intake", async () => {
      await expect(cancelIntake(db as any, "does-not-exist", "admin-1")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("repository: a concurrent double-cancel produces exactly one atomic update and one idempotent read", async () => {
      const created = await createIntake(db as any, "admin-1");
      const repo = createDrizzleAiProductIntakeRepository(db as any, sqliteSchema);
      const cancelledAt = new Date().toISOString();

      const first = await repo.cancelWithExpectedState({
        id: created.id,
        expectedStatus: AiProductIntakeStatus.Open,
        cancelledByAdminUserId: "admin-a",
        cancelledAt,
        cancellationReason: "first",
        updatedAt: cancelledAt,
      });
      const second = await repo.cancelWithExpectedState({
        id: created.id,
        expectedStatus: AiProductIntakeStatus.Open,
        cancelledByAdminUserId: "admin-b",
        cancelledAt: new Date(Date.now() + 1000).toISOString(),
        cancellationReason: "second",
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      });

      expect(first.updated).toBe(true);
      expect(second.updated).toBe(false);
      expect(second.conflict?.field).toBe("status");
      expect(second.row?.status).toBe(AiProductIntakeStatus.Cancelled);
      expect(second.row?.cancelledByAdminUserId).toBe("admin-a");
    });

    it("Sprint 96: cancelling a Finalized intake is rejected with BadRequestError, and the intake remains Finalized (real end-to-end apply + finalize flow, not a direct DB row edit)", async () => {
      function mockPhotoStorage(): AiIntakePhotoStorage {
        let counter = 0;
        return {
          saveIntakePhoto: async () => {
            counter += 1;
            return { storageKey: `mock-key-${counter}.webp` };
          },
          deleteIntakePhoto: async () => {},
        };
      }

      const category = await createCategory(db as any, { name: "Sprint 96 Cancel-Finalized Category", displayOrder: 0, isActive: true } as any);
      const intake = await createIntake(db as any, "admin-1");
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);

      const generated = await generateIntakeProposal(db as any, intake.id, {
        generate: async (req: any) => ({
          proposal: { suggestedTitle: "Cancel Finalized Title", suggestedDescription: "d", suggestedKeywords: ["k"], confidenceScore: 0.8 },
          metadata: { providerName: "stub-provider", promptVersion: req.prompt.version },
        }),
      } as any);
      const reviewed = await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      await saveAiIntakeAsDraft(
        db as any,
        intake.id,
        { sku: "SKU-CANCEL-FINALIZED-96", categoryId: category.id, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
        "admin-3",
      );
      const manifestDeps = {
        readStagedPhotoBytes: async () => Buffer.from("bytes"),
        writeDeterministicPhoto: async (input: any) => ({
          mainStorageKey: input.mainStorageKey,
          thumbnailStorageKey: input.thumbnailStorageKey,
          url: `/images/product-photos/${input.mainStorageKey}`,
          thumbnailUrl: `/images/product-photos/${input.thumbnailStorageKey}`,
          mimeType: "image/webp",
          sizeBytes: input.size,
          width: 10,
          height: 10,
        }),
      };
      await finalizeAiIntakePhotos(db as any, intake.id, {}, "admin-4", manifestDeps as any);

      const finalizedIntake = await getIntakeById(db as any, intake.id);
      expect(finalizedIntake.status).toBe(AiProductIntakeStatus.Finalized);

      await expect(cancelIntake(db as any, intake.id, "admin-5", "should not be allowed")).rejects.toBeInstanceOf(BadRequestError);

      const intakeAfterRejectedCancel = await getIntakeById(db as any, intake.id);
      expect(intakeAfterRejectedCancel.status).toBe(AiProductIntakeStatus.Finalized);
      expect(intakeAfterRejectedCancel.cancelledAt).toBeUndefined();
      expect(intakeAfterRejectedCancel.cancelledByAdminUserId).toBeUndefined();
    });
  });

  describe("database foundation", () => {
    it("SQLite ensureSchema is idempotent for the new table", () => {
      const sqlite = new Database(":memory:");
      sqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(sqlite)).not.toThrow();
      expect(() => ensureSchema(sqlite)).not.toThrow();
      const columns = (sqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "id",
          "status",
          "created_by_admin_user_id",
          "result_product_id",
          "cancelled_at",
          "cancelled_by_admin_user_id",
          "cancellation_reason",
          "created_at",
          "updated_at",
        ]),
      );
      sqlite.close();
    });

    it("SQLite Drizzle construction works against the new table", async () => {
      const repo = createDrizzleAiProductIntakeRepository(db as any, sqliteSchema);
      const row = await repo.create({ id: "sqlite-construction-check", createdByAdminUserId: "admin-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      expect(row.id).toBe("sqlite-construction-check");
    });

    it("PostgreSQL Drizzle construction remains valid for the ai-product-intake repository", () => {
      const testDbHandle = drizzle(new Database(":memory:"), { schema: sqliteSchema });
      const repo = createDrizzleAiProductIntakeRepository(testDbHandle as any, postgresSchema);
      expect(repo.create).toBeTypeOf("function");
      expect(repo.findById).toBeTypeOf("function");
      expect(repo.cancelWithExpectedState).toBeTypeOf("function");
    });

    it("the repository factory resolves sqlite, postgres, and rejects unsupported drivers", () => {
      expect(() => createAiProductIntakeRepository("sqlite", db)).not.toThrow();
      expect(() => createAiProductIntakeRepository("postgres", db)).not.toThrow();
      expect(() => createAiProductIntakeRepository("nonsense-driver", db)).toThrow();
    });

    it("nullable resultProductId permits multiple null values", async () => {
      await createIntake(db as any, "admin-1");
      await createIntake(db as any, "admin-2");
      const rows = await db.select().from(aiProductIntakes);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.resultProductId === null)).toBe(true);
    });

    it("a duplicate non-null resultProductId violates the unique constraint", async () => {
      const a = await createIntake(db as any, "admin-1");
      const b = await createIntake(db as any, "admin-2");
      await db.update(aiProductIntakes).set({ resultProductId: "shared-product-id" }).where(eq(aiProductIntakes.id, a.id));
      await expect(
        db.update(aiProductIntakes).set({ resultProductId: "shared-product-id" }).where(eq(aiProductIntakes.id, b.id)),
      ).rejects.toThrow();
    });

    it("database parity includes ai_product_intakes", () => {
      expect(requiredSprint24Tables).toContain("ai_product_intakes");
      const parity = runSchemaParity();
      expect(parity.status).toBe("PASS");
      expect(parity.tables.find((t) => t.name === "ai_product_intakes")?.sqlite).toBe(true);
    });

    it("migration preview / postgres migration set includes migration 0008 and creates ai_product_intakes without dropping anything", () => {
      const migrationSql = read("src/db/postgres-migrations/0008_sprint90_ai_product_intake_foundation.sql");
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_product_intakes");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);

      const validation = validatePostgresMigrationSql();
      expect(validation.status).toBe("PASS");
      expect(validation.missingTables).not.toContain("ai_product_intakes");
      expect(validation.hasDrop).toBe(false);
    });
  });

  describe("permissions", () => {
    it("ProductEditor receives ai_product_intakes.view and ai_product_intakes.manage", () => {
      expect(ROLE_PERMISSIONS[AdminRole.ProductEditor]).toContain("ai_product_intakes.view");
      expect(ROLE_PERMISSIONS[AdminRole.ProductEditor]).toContain("ai_product_intakes.manage");
    });

    it("AiReviewer does not receive any ai_product_intakes permission", () => {
      expect(ROLE_PERMISSIONS[AdminRole.AiReviewer]).not.toContain("ai_product_intakes.view");
      expect(ROLE_PERMISSIONS[AdminRole.AiReviewer]).not.toContain("ai_product_intakes.manage");
    });

    it("Owner and Admin receive both ai_product_intakes permissions", () => {
      expect(ROLE_PERMISSIONS[AdminRole.Owner]).toEqual(expect.arrayContaining(["ai_product_intakes.view", "ai_product_intakes.manage"]));
      expect(ROLE_PERMISSIONS[AdminRole.Admin]).toEqual(expect.arrayContaining(["ai_product_intakes.view", "ai_product_intakes.manage"]));
    });
  });

  describe("ai_listing_drafts remains untouched", () => {
    it("does not reference or depend on the AI Draft system", () => {
      const serviceSource = read("src/services/aiProductIntakes.ts");
      const useCaseSource = read("src/use-cases/ai-product-intake/useCases.ts");
      const repoSource = read("src/repositories/ai-product-intake/drizzle.ts");
      // Only import/reference statements are checked - a comment mentioning the
      // ai-draft precedent by name (as prior art to mirror) is not a dependency.
      const importLines = (source: string) => source.split("\n").filter((line) => /^\s*import /.test(line)).join("\n");
      for (const source of [serviceSource, useCaseSource, repoSource]) {
        expect(importLines(source)).not.toMatch(/aiListingDrafts|AiDraftStatus|\/ai-draft\//);
      }
    });
  });
});
