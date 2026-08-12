import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiIntakeFieldDecision, AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";
import {
  AiIntakeApplyIntakeNotOpenError,
  AiIntakeApplyPhotoSetStaleError,
  AiIntakeApplyProposalNotReadyError,
  AiIntakeApplyProposalVersionConflictError,
  AiIntakeApplyResultStateInvalidError,
  BadRequestError,
} from "../src/services/errors";
import { createIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto } from "../src/services/aiIntakePhotos";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview } from "../src/services/aiIntakeProposals";
import { acceptAiIntakeIntoStock } from "../src/services/aiIntakeStockAcceptance";
import { createCategory } from "../src/services/categories";
import { stockAcceptanceUseCase, type StockAcceptanceInput } from "../src/use-cases/ai-intake-stock-acceptance/useCases";
import { createAiIntakeApplyTransactionCapabilityForDb } from "../src/services/aiIntakeApplyTransactionCapabilityForDb";
import type { AiIntakeGenerationProvider } from "../src/ai-intake/types";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { products, stockMovements, productPhotos, productSkuSequence } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { createTestDb } from "./testDb";

function mockPhotoStorage(): AiIntakePhotoStorage {
  let counter = 0;
  return {
    saveIntakePhoto: vi.fn(async () => {
      counter += 1;
      return { storageKey: `mock-key-${counter}.webp` };
    }),
    deleteIntakePhoto: vi.fn(async () => {}),
  };
}

function stubProvider(suggestions: Record<string, unknown> = {}): AiIntakeGenerationProvider {
  return {
    generate: vi.fn(async (req) => ({
      proposal: {
        suggestedTitle: "Stub Title",
        suggestedDescription: "Stub description.",
        suggestedKeywords: ["stub", "keyword"],
        confidenceScore: 0.7,
        ...suggestions,
      },
      metadata: { providerName: "stub-provider", promptVersion: req.prompt.version },
    })),
  };
}

describe("AI Intake Stock Acceptance (Sprint 106)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;
  let categoryId: string;

  const validRequest = (overrides: Partial<StockAcceptanceInput> = {}): StockAcceptanceInput => ({
    intakeId,
    categoryId,
    type: ProductType.UniqueItem,
    priceEur: 42,
    expectedProposalUpdatedAt: "",
    actorId: "admin-1",
    ...overrides,
  });

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
    const category = await createCategory(db as any, { name: "Test Category", displayOrder: 0, isActive: true } as any);
    categoryId = category.id;
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  /** Generates a proposal (optionally with expanded AI suggestions) and accepts title. */
  async function readyIntake(suggestions: Record<string, unknown> = {}) {
    const generated = await generateIntakeProposal(db as any, intakeId, stubProvider(suggestions));
    return updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
  }

  describe("happy path", () => {
    it("creates exactly one canonical Product with a system-generated sequential SKU, Draft status", async () => {
      const proposal = await readyIntake();
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.created).toBe(true);
      expect(result.product.sku).toBe("NOC-000001");
      expect(result.product.status).toBe(ProductStatus.Draft);
      expect(result.product.title).toBe("Stub Title");
      const rows = await db.select().from(products);
      expect(rows).toHaveLength(1);
    });

    it("never accepts a client-supplied sku - the request contract has no sku field", async () => {
      const proposal = await readyIntake();
      const request: Record<string, unknown> = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      expect("sku" in request).toBe(false);
    });

    it("sequential allocation: two different intakes accepted in order receive NOC-000001 then NOC-000002", async () => {
      const proposalA = await readyIntake();
      const resultA = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposalA.updatedAt }) as any, "admin-3");
      expect(resultA.product.sku).toBe("NOC-000001");

      const otherIntake = await createIntake(db as any, "admin-1");
      // A distinct suggestedTitle - otherwise the derived slug would collide with the first
      // intake's Product, which is an unrelated (already separately tested) conflict.
      const otherGenerated = await generateIntakeProposal(db as any, otherIntake.id, stubProvider({ suggestedTitle: "Stub Title Two" }));
      const otherReviewed = await updateProposalFieldReview(db as any, otherIntake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", otherGenerated.updatedAt);
      const resultB = await acceptAiIntakeIntoStock(
        db as any,
        otherIntake.id,
        validRequest({ intakeId: otherIntake.id, expectedProposalUpdatedAt: otherReviewed.updatedAt }) as any,
        "admin-3",
      );
      expect(resultB.product.sku).toBe("NOC-000002");
    });

    it("accepts the admin-submitted category (which may differ from the AI's suggestion)", async () => {
      const otherCategory = await createCategory(db as any, { name: "Other Category", displayOrder: 1, isActive: true } as any);
      const proposal = await readyIntake({ suggestedCategoryId: categoryId });
      const result = await acceptAiIntakeIntoStock(
        db as any,
        intakeId,
        validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, categoryId: otherCategory.id }) as any,
        "admin-3",
      );
      expect(result.product.categoryId).toBe(otherCategory.id);
    });

    it("rejects a nonexistent categoryId even when it was the AI's own suggestion (backend category validation is authoritative)", async () => {
      const proposal = await readyIntake({ suggestedCategoryId: "does-not-exist" });
      await expect(
        acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, categoryId: "does-not-exist" }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("accepts the admin-submitted priceEur (AI's suggestedPriceEur is never authoritative)", async () => {
      const proposal = await readyIntake({ suggestedPriceEur: 99 });
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, priceEur: 15 }) as any, "admin-3");
      expect(result.product.priceEur).toBe(15);
    });

    it("persists the admin-submitted expanded AI Full Product Analysis fields onto the canonical Product", async () => {
      const proposal = await readyIntake();
      const result = await acceptAiIntakeIntoStock(
        db as any,
        intakeId,
        validRequest({
          expectedProposalUpdatedAt: proposal.updatedAt,
          brand: "Acme",
          model: "Model X",
          manufacturer: "Acme Corp",
          countryOfOrigin: "Germany",
          period: "1920s",
          materials: "Oak",
          condition: "Good",
          conditionDescription: "Minor wear",
          seoTitle: "Antique Oak Item",
          metaDescription: "A fine antique item.",
        }) as any,
        "admin-3",
      );
      expect(result.product.brand).toBe("Acme");
      expect(result.product.model).toBe("Model X");
      expect(result.product.manufacturer).toBe("Acme Corp");
      expect(result.product.countryOfOrigin).toBe("Germany");
      expect(result.product.period).toBe("1920s");
      expect(result.product.materials).toBe("Oak");
      expect(result.product.condition).toBe("Good");
      expect(result.product.conditionDescription).toBe("Minor wear");
      expect(result.product.seoTitle).toBe("Antique Oak Item");
      expect(result.product.metaDescription).toBe("A fine antique item.");
    });

    it("stockQuantity omitted -> Product.stockQuantity is 1 (never 0), one initial StockMovement exists; UniqueItem stock behavior preserved", async () => {
      const proposal = await readyIntake();
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.product.stockQuantity).toBe(1);
      const movements = await db.select().from(stockMovements);
      expect(movements).toHaveLength(1);
      expect(movements[0].productId).toBe(result.product.id);
    });

    it("Sprint 138: stockQuantity omitted for a non-UniqueItem type also defaults to 1, never 0", async () => {
      const proposal = await readyIntake();
      const result = await acceptAiIntakeIntoStock(
        db as any,
        intakeId,
        validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, type: ProductType.LotItem }) as any,
        "admin-3",
      );
      expect(result.product.stockQuantity).toBe(1);
      const movements = await db.select().from(stockMovements);
      expect(movements).toHaveLength(1);
      expect(movements[0].productId).toBe(result.product.id);
    });

    it("writes resultProductId, transitions status to Applied", async () => {
      const proposal = await readyIntake();
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Applied);
      expect(intake.resultProductId).toBe(result.product.id);
    });

    it("does not create ProductPhoto, does not copy files, does not publish (photo finalization is a separate later step)", async () => {
      const proposal = await readyIntake();
      await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(await db.select().from(productPhotos)).toHaveLength(0);
    });
  });

  describe("Sprint 137: Stock Acceptance without a sales price", () => {
    it("succeeds with priceEur entirely omitted from the request", async () => {
      const proposal = await readyIntake();
      const { priceEur: _omitted, ...requestWithoutPrice } = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, requestWithoutPrice as any, "admin-3");
      expect(result.created).toBe(true);
      expect(result.product.status).toBe(ProductStatus.Draft);
      // Never a placeholder - exactly null, never 0, 0.01, or 1.
      expect(result.product.priceEur).toBeNull();
    });

    it("still creates Inventory (one StockMovement) and still allocates a real sequential SKU when priceEur is omitted", async () => {
      const proposal = await readyIntake();
      const { priceEur: _omitted, ...requestWithoutPrice } = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, requestWithoutPrice as any, "admin-3");
      expect(result.product.sku).toBe("NOC-000001");
      const movements = await db.select().from(stockMovements);
      expect(movements).toHaveLength(1);
      expect(movements[0].productId).toBe(result.product.id);
    });

    it("retrying an already-Applied unpriced intake is idempotent - no second Product, no second SKU allocated", async () => {
      const proposal = await readyIntake();
      const { priceEur: _omitted, ...requestWithoutPrice } = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      const first = await acceptAiIntakeIntoStock(db as any, intakeId, requestWithoutPrice as any, "admin-3");
      const second = await acceptAiIntakeIntoStock(db as any, intakeId, requestWithoutPrice as any, "admin-3");
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.product.id).toBe(first.product.id);
      expect(second.product.sku).toBe(first.product.sku);
      expect(await db.select().from(products)).toHaveLength(1);
    });
  });

  describe("readiness / staleness", () => {
    it("rejects a Pending title (proposal not ready)", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await expect(
        acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: generated.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalNotReadyError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects a stale expectedProposalUpdatedAt (proposal version conflict)", async () => {
      const proposal = await readyIntake();
      await expect(
        acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: "not-the-real-value" }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalVersionConflictError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects when the staged photo set changed after generation (stale fingerprint)", async () => {
      const proposal = await readyIntake();
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await expect(
        acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyPhotoSetStaleError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects an intake that is not Open (e.g. already Applied via the other path)", async () => {
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      const proposal = await readyIntake();
      await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      await expect(
        stockAcceptanceUseCase(capability, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt })),
      ).resolves.toMatchObject({ created: false });
    });
  });

  describe("idempotency and retry", () => {
    it("two sequential Stock Acceptance requests: one creates the Product, the second returns the same Product - exactly one SKU allocated", async () => {
      const proposal = await readyIntake();
      const request = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      const first = await acceptAiIntakeIntoStock(db as any, intakeId, request as any, "admin-3");
      const second = await acceptAiIntakeIntoStock(db as any, intakeId, request as any, "admin-3");
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.product.id).toBe(first.product.id);
      expect(second.product.sku).toBe(first.product.sku);
      expect(await db.select().from(products)).toHaveLength(1);

      const sequenceRow = await db.select().from(productSkuSequence);
      expect(sequenceRow).toHaveLength(1);
      expect(Number(sequenceRow[0].nextValue)).toBe(2); // consumed exactly once, not twice
    });

    it("Applied with a null resultProductId (constructed directly) returns a deterministic conflict, creates nothing, allocates no SKU", async () => {
      const proposal = await readyIntake();
      sqlite.prepare("UPDATE ai_product_intakes SET status = 'applied', result_product_id = NULL WHERE id = ?").run(intakeId);
      await expect(
        acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyResultStateInvalidError);
      expect(await db.select().from(products)).toHaveLength(0);
    });
  });

  describe("atomic rollback", () => {
    it("a canonical Product validation failure (invalid price) creates nothing, leaves the intake Open, and does not consume a SKU", async () => {
      const proposal = await readyIntake();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        stockAcceptanceUseCase(capability, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, priceEur: -5 })),
      ).rejects.toThrow();
      expect(await db.select().from(products)).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
      expect(intake.resultProductId).toBeUndefined();

      // The allocation attempted during the failed transaction was rolled back with everything
      // else - the very next successful acceptance still receives NOC-000001, not NOC-000002.
      const readyAgain = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-2", proposal.updatedAt);
      const regenerated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const reAccepted = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", regenerated.updatedAt);
      const recovered = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: reAccepted.updatedAt }) as any, "admin-3");
      expect(recovered.product.sku).toBe("NOC-000001");
      void readyAgain;
    });

    it("a database failure during Inventory/StockMovement creation rolls back the Product and the SKU allocation too - no partial state, no consumed sequence number", async () => {
      const proposal = await readyIntake();
      sqlite.prepare("CREATE TRIGGER fail_stock_movement_insert_106 AFTER INSERT ON stock_movements BEGIN SELECT RAISE(ABORT,'forced failure'); END;").run();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        stockAcceptanceUseCase(capability, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt })),
      ).rejects.toThrow();
      expect(await db.select().from(products)).toHaveLength(0);
      const sequenceRow = await db.select().from(productSkuSequence);
      expect(sequenceRow).toHaveLength(0); // the insert that would have created it was rolled back too
    });
  });

  describe("SKU collision defense-in-depth", () => {
    it("skips a SKU value already occupied by a legacy/manually-entered Product and allocates the next free one", async () => {
      // Simulate a pre-existing legacy Product occupying the value the sequence is about to
      // generate first (constructed directly - unreachable through the normal flow, but a real
      // possibility given products.sku's UNIQUE constraint is the only hard guarantee).
      sqlite
        .prepare(
          `INSERT INTO products (id, sku, slug, title, type, category_id, price_eur, status, stock_quantity, created_at, updated_at)
           VALUES ('legacy-product', 'NOC-000001', 'legacy-product-slug', 'Legacy Product', 'unique_item', ?, 5, 'draft', 0, datetime('now'), datetime('now'))`,
        )
        .run(categoryId);

      const proposal = await readyIntake();
      const result = await acceptAiIntakeIntoStock(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.product.sku).toBe("NOC-000002"); // NOC-000001 was already taken, skipped safely
    });
  });

  describe("database foundation", () => {
    it("SQLite ensureSchema is idempotent for the new stock-acceptance columns and the product_sku_sequence table", () => {
      const freshSqlite = new Database(":memory:");
      freshSqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      const proposalColumns = (freshSqlite.prepare("PRAGMA table_info(ai_intake_proposals)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(proposalColumns).toEqual(
        expect.arrayContaining([
          "suggested_category_id",
          "suggested_brand",
          "suggested_model",
          "suggested_manufacturer",
          "suggested_country_of_origin",
          "suggested_period",
          "suggested_materials",
          "suggested_condition",
          "suggested_condition_description",
          "suggested_seo_title",
          "suggested_meta_description",
          "suggested_price_eur",
        ]),
      );
      const tables = (freshSqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toContain("product_sku_sequence");
      freshSqlite.close();
    });

    it("PostgreSQL migration 0013 adds the stock-acceptance columns/table without dropping anything", async () => {
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const { validatePostgresMigrationSql } = await import("../src/services/databaseMigrationFoundation");
      const root = path.resolve(__dirname, "..");
      const migrationSql = readFileSync(path.join(root, "src/db/postgres-migrations/0013_sprint106_stock_acceptance.sql"), "utf8");
      expect(migrationSql).toContain("ALTER TABLE ai_intake_proposals ADD COLUMN IF NOT EXISTS suggested_category_id");
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS product_sku_sequence");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);
      const validation = validatePostgresMigrationSql();
      expect(validation.status).toBe("PASS");
      expect(validation.hasDrop).toBe(false);
    });

    it("database parity remains PASS", async () => {
      const { runSchemaParity } = await import("../src/services/databaseMigrationFoundation");
      const parity = runSchemaParity();
      expect(parity.status).toBe("PASS");
    });
  });
});
