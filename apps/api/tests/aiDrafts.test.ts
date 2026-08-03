import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { AiDraftStatus, ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiListingGenerationInput, AiListingGenerationResult, AiListingProvider } from "../src/ai/provider";
import { createCategory } from "../src/services/categories";
import { createCollection } from "../src/services/collections";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import { AiDraftRegenerationRequiredError, AiDraftReviewConflictError, BadRequestError, NotFoundError, ProductVersionConflictError } from "../src/services/errors";
import {
  approveDraft,
  generateDraft,
  getDraftById,
  listDrafts,
  regenerateDraft,
  rejectDraft,
  updateDraft,
} from "../src/services/aiDrafts";
import { aiListingDrafts, externalListings, publishJobs } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { createDrizzleAiDraftApprovalRepository } from "../src/repositories/ai-draft/drizzle";
import { createAiDraftApprovalTransactionCapabilityForDb } from "../src/services/aiDraftApprovalTransactionCapabilityForDb";
import { approveAiListingDraftUseCase } from "../src/use-cases/ai-draft/useCases";
import { ensureSchema } from "../src/db/migrate";
import { createTestDb } from "./testDb";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** Deterministic stub provider for tests — avoids depending on mock-provider's exact text output. */
class StubProvider implements AiListingProvider {
  constructor(private result: Partial<AiListingGenerationResult> = {}) {}

  async generateListing(_input: AiListingGenerationInput): Promise<AiListingGenerationResult> {
    return {
      generatedTitle: "Stub Generated Title",
      generatedDescription: "Stub generated description.",
      generatedStory: "Stub story.",
      generatedConditionDescription: "Stub condition.",
      suggestedEurPrice: 999,
      seoTitle: "Stub SEO Title",
      metaDescription: "Stub meta description.",
      keywords: ["stub", "keyword"],
      aiConfidenceScore: 0.75,
      aiModel: "stub-model",
      generationPromptVersion: "test-v1",
      ...this.result,
    };
  }
}

class FailingProvider implements AiListingProvider {
  async generateListing(): Promise<AiListingGenerationResult> {
    throw new Error("Simulated provider failure");
  }
}

describe("ai draft service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let productId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const product = await createProduct(db, {
      sku: "SKU-AI-001",
      title: "Vintage Chronograph",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 1200,
    });
    productId = product.id;
  });

  it("generates a draft that starts Pending Review", async () => {
    const draft = await generateDraft(db, productId, new StubProvider());
    expect(draft.status).toBe(AiDraftStatus.PendingReview);
    expect(draft.generatedTitle).toBe("Stub Generated Title");
    expect(draft.aiModel).toBe("stub-model");
  });

  it("does not auto-publish the product when a draft is generated", async () => {
    await generateDraft(db, productId, new StubProvider());
    const product = await getProductById(db, productId);
    expect(product.status).toBe(ProductStatus.Draft);
  });

  it("marketplace/inventory fields are not required for generation", async () => {
    // Product created in beforeEach has no marketplace fields set at all.
    const draft = await generateDraft(db, productId, new StubProvider());
    expect(draft.status).toBe(AiDraftStatus.PendingReview);
  });

  it("approve copies only website/product fields and sets product status to Approved", async () => {
    const draft = await generateDraft(db, productId, new StubProvider());
    const approved = await approveDraft(db, draft.id, "admin-1");

    expect(approved.status).toBe(AiDraftStatus.Approved);
    expect(approved.reviewedByAdminUserId).toBe("admin-1");
    expect(approved.reviewedAt).toBeTruthy();

    const product = await getProductById(db, productId);
    expect(product.status).toBe(ProductStatus.Approved);
    expect(product.title).toBe("Stub Generated Title");
    expect(product.description).toBe("Stub generated description.");
    expect(product.priceEur).toBe(999);
  });

  it("approve does not overwrite SKU, purchase cost, stock quantity, or internal notes", async () => {
    const productWithInternals = await createProduct(db, {
      sku: "SKU-AI-002",
      title: "Another Item",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 500,
      purchaseCost: 200,
      stockQuantity: 1,
      internalNotes: "Bought from estate sale, do not discount.",
    });

    const draft = await generateDraft(db, productWithInternals.id, new StubProvider());
    await approveDraft(db, draft.id, "admin-1");

    const product = await getProductById(db, productWithInternals.id);
    expect(product.sku).toBe("SKU-AI-002");
    expect(product.purchaseCost).toBe(200);
    expect(product.stockQuantity).toBe(1);
    expect(product.internalNotes).toBe("Bought from estate sale, do not discount.");
  });

  it("approve does not mutate stock quantity or Inventory, and performs no publishing/marketplace action", async () => {
    const stockedProduct = await createProduct(db, {
      sku: "SKU-AI-STOCK",
      title: "Stocked Item",
      type: ProductType.LotItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
      stockQuantity: 7,
    });
    const draft = await generateDraft(db, stockedProduct.id, new StubProvider());
    await approveDraft(db, draft.id, "admin-1");

    const product = await getProductById(db, stockedProduct.id);
    expect(product.stockQuantity).toBe(7);
    expect((await db.select().from(publishJobs)).length).toBe(0);
    expect((await db.select().from(externalListings)).length).toBe(0);
  });

  it("reject requires a rejection reason", async () => {
    const draft = await generateDraft(db, productId, new StubProvider());
    await expect(
      rejectDraft(db, draft.id, { rejectionReason: "" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("reject leaves the product unchanged", async () => {
    const draft = await generateDraft(db, productId, new StubProvider());
    await rejectDraft(db, draft.id, { rejectionReason: "Title doesn't match brand voice" });

    const product = await getProductById(db, productId);
    expect(product.status).toBe(ProductStatus.Draft);
    expect(product.title).toBe("Vintage Chronograph");

    const rejected = await getDraftById(db, draft.id);
    expect(rejected.status).toBe(AiDraftStatus.Rejected);
    expect(rejected.rejectionReason).toBe("Title doesn't match brand voice");
  });

  it("regenerate creates a new draft and supersedes the previous one only on success", async () => {
    const firstDraft = await generateDraft(db, productId, new StubProvider());
    const secondDraft = await regenerateDraft(db, firstDraft.id, new StubProvider({ generatedTitle: "Second Title" }));

    expect(secondDraft.id).not.toBe(firstDraft.id);
    expect(secondDraft.status).toBe(AiDraftStatus.PendingReview);

    const supersededFirst = await getDraftById(db, firstDraft.id);
    expect(supersededFirst.status).toBe(AiDraftStatus.Superseded);
  });

  it("failed regeneration preserves the previous valid draft", async () => {
    const firstDraft = await generateDraft(db, productId, new StubProvider());

    await expect(regenerateDraft(db, firstDraft.id, new FailingProvider())).rejects.toThrow(
      "Simulated provider failure",
    );

    const preserved = await getDraftById(db, firstDraft.id);
    expect(preserved.status).toBe(AiDraftStatus.PendingReview);
    expect(preserved.generatedTitle).toBe("Stub Generated Title");
  });

  it("only a Pending Review draft can be approved", async () => {
    const draft = await generateDraft(db, productId, new StubProvider());
    await approveDraft(db, draft.id, "admin-1");
    await expect(approveDraft(db, draft.id, "admin-1")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("only a Pending Review draft can be edited", async () => {
    const draft = await generateDraft(db, productId, new StubProvider());
    await rejectDraft(db, draft.id, { rejectionReason: "Not accurate" });
    await expect(updateDraft(db, draft.id, { generatedTitle: "New Title" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("lists drafts with search, status filter, and pagination", async () => {
    await generateDraft(db, productId, new StubProvider());

    const category2 = await createCategory(db, { name: "Pens", displayOrder: 1, isActive: true });
    const secondProduct = await createProduct(db, {
      sku: "SKU-AI-003",
      title: "Fountain Pen",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId: category2.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 200,
    });
    await generateDraft(db, secondProduct.id, new StubProvider());

    const bySearch = await listDrafts(db, {
      page: 1,
      pageSize: 20,
      search: "Chronograph",
    });
    expect(bySearch.items).toHaveLength(1);
    expect(bySearch.items[0].productTitle).toBe("Vintage Chronograph");

    const byStatus = await listDrafts(db, { page: 1, pageSize: 20, status: AiDraftStatus.PendingReview });
    expect(byStatus.total).toBe(2);

    const page1 = await listDrafts(db, { page: 1, pageSize: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(2);
  });

  describe("Sprint 89: generation-time Product version baseline (ADR-017 repair)", () => {
    it("generation stores the exact generation-input Product updatedAt as baseProductUpdatedAt", async () => {
      const productBefore = await getProductById(db, productId);
      const draft = await generateDraft(db, productId, new StubProvider());
      expect(draft.baseProductUpdatedAt).toBe(productBefore.updatedAt);
    });

    it("regeneration creates a new draft with a newly captured baseline, and the superseded draft retains its original baseline", async () => {
      const firstDraft = await generateDraft(db, productId, new StubProvider());
      // A manual edit between generation and regeneration bumps updatedAt (Sprint 88 canonical path).
      // Nothing else touched the Product since generation, so its current token is still exactly
      // firstDraft.baseProductUpdatedAt.
      const edited = await updateProduct(db, productId, { title: "Edited Between Generations", expectedUpdatedAt: firstDraft.baseProductUpdatedAt! });
      const secondDraft = await regenerateDraft(db, firstDraft.id, new StubProvider({ generatedTitle: "Second Title" }));

      expect(secondDraft.baseProductUpdatedAt).toBe(edited.updatedAt);
      expect(secondDraft.baseProductUpdatedAt).not.toBe(firstDraft.baseProductUpdatedAt);

      const supersededFirst = await getDraftById(db, firstDraft.id);
      expect(supersededFirst.baseProductUpdatedAt).toBe(firstDraft.baseProductUpdatedAt);
    });

    it("legacy draft rows (inserted without a baseline, as if from before this migration) remain null", async () => {
      const now = new Date().toISOString();
      await db.insert(aiListingDrafts).values({
        id: "legacy-draft",
        productId,
        status: AiDraftStatus.PendingReview,
        generatedTitle: "Legacy Title",
        createdAt: now,
        updatedAt: now,
      } as any);
      const legacy = await getDraftById(db, "legacy-draft");
      expect(legacy.baseProductUpdatedAt).toBeUndefined();
    });

    it("SQLite ensureSchema migration is repeatable (idempotent ALTER TABLE)", () => {
      const sqlite = new Database(":memory:");
      sqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(sqlite)).not.toThrow();
      expect(() => ensureSchema(sqlite)).not.toThrow();
      const columns = (sqlite.prepare("PRAGMA table_info(ai_listing_drafts)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toContain("base_product_updated_at");
      sqlite.close();
    });

    it("PostgreSQL dialect construction remains valid for the ai-draft approval repository, and the migration adds the column without dropping anything", () => {
      const testDbHandle = drizzle(new Database(":memory:"), { schema: sqliteSchema });
      const repo = createDrizzleAiDraftApprovalRepository(testDbHandle as any, postgresSchema, "asynchronous");
      expect(repo.claimAndApprove).toBeTypeOf("function");
      expect(repo.findById).toBeTypeOf("function");
      const migrationSql = read("src/db/postgres-migrations/0007_sprint89_ai_draft_generation_baseline.sql");
      expect(migrationSql).toContain("base_product_updated_at");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);
    });
  });

  describe("Sprint 89: validation, conflict, and rollback behavior", () => {
    it("a legacy draft with no baseline cannot be approved (AI_DRAFT_REGENERATION_REQUIRED)", async () => {
      const now = new Date().toISOString();
      await db.insert(aiListingDrafts).values({
        id: "legacy-draft-2",
        productId,
        status: AiDraftStatus.PendingReview,
        generatedTitle: "Legacy Title",
        createdAt: now,
        updatedAt: now,
      } as any);
      await expect(approveDraft(db, "legacy-draft-2", "admin-1")).rejects.toBeInstanceOf(AiDraftRegenerationRequiredError);
      const stillPending = await getDraftById(db, "legacy-draft-2");
      expect(stillPending.status).toBe(AiDraftStatus.PendingReview);
    });

    it("an invalid suggested category rejects approval and leaves the draft Pending Review", async () => {
      const draft = await generateDraft(db, productId, new StubProvider());
      await db.update(aiListingDrafts).set({ suggestedCategoryId: "does-not-exist" }).where(eq(aiListingDrafts.id, draft.id));
      await expect(approveDraft(db, draft.id, "admin-1")).rejects.toBeInstanceOf(BadRequestError);
      const stillPending = await getDraftById(db, draft.id);
      expect(stillPending.status).toBe(AiDraftStatus.PendingReview);
      const productUnchanged = await getProductById(db, productId);
      expect(productUnchanged.title).toBe("Vintage Chronograph");
    });

    it("an invalid suggested collection rejects approval", async () => {
      const draft = await generateDraft(db, productId, new StubProvider());
      await db.update(aiListingDrafts).set({ suggestedCollectionId: "does-not-exist" }).where(eq(aiListingDrafts.id, draft.id));
      await expect(approveDraft(db, draft.id, "admin-1")).rejects.toBeInstanceOf(BadRequestError);
    });

    it("a valid suggested category/collection approve successfully", async () => {
      const collection = await createCollection(db, { name: "Vintage", displayOrder: 0, isActive: true });
      const draft = await generateDraft(db, productId, new StubProvider());
      await db.update(aiListingDrafts).set({ suggestedCollectionId: collection.id }).where(eq(aiListingDrafts.id, draft.id));
      const approved = await approveDraft(db, draft.id, "admin-1");
      expect(approved.status).toBe(AiDraftStatus.Approved);
      const product = await getProductById(db, productId);
      expect(product.collectionId).toBe(collection.id);
    });

    it("approval targeting a nonexistent Product throws NotFoundError", async () => {
      // ai_listing_drafts.product_id carries a real FOREIGN KEY (enforced in tests via
      // `PRAGMA foreign_keys = ON`), so a draft can never actually point at a deleted/nonexistent
      // Product in practice - Products are archive-only and never hard-deleted. To still prove the
      // use case's NotFoundError path (backed by Sprint 88's already-proven repository not-found
      // branch), this calls the use case directly with a synthetic productId rather than going
      // through a real FK-linked draft row.
      const draft = await generateDraft(db, productId, new StubProvider());
      const capability = createAiDraftApprovalTransactionCapabilityForDb(db as any, "sqlite");
      const inventoryCtx = { clock: { now: () => new Date() }, idGenerator: { newId: () => "unused" } };
      await expect(
        (async () =>
          approveAiListingDraftUseCase(capability, inventoryCtx, {
            id: draft.id,
            status: AiDraftStatus.PendingReview,
            productId: "does-not-exist",
            baseProductUpdatedAt: draft.baseProductUpdatedAt!,
            reviewedByAdminUserId: "admin-1",
            productValues: { status: ProductStatus.Approved },
          }))(),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a Product changed after generation causes ProductVersionConflictError, leaves the draft Pending Review, and leaves the Product as the intervening edit left it", async () => {
      const draft = await generateDraft(db, productId, new StubProvider());
      const intervening = await updateProduct(db, productId, { title: "Changed By Someone Else", expectedUpdatedAt: draft.baseProductUpdatedAt! });

      await expect(approveDraft(db, draft.id, "admin-1")).rejects.toBeInstanceOf(ProductVersionConflictError);

      const stillPending = await getDraftById(db, draft.id);
      expect(stillPending.status).toBe(AiDraftStatus.PendingReview);

      const productAfter = await getProductById(db, productId);
      expect(productAfter.title).toBe("Changed By Someone Else");
      expect(productAfter.updatedAt).toBe(intervening.updatedAt);
    });

    it("a successful AI Draft approval advances Product.updatedAt strictly beyond the generation baseline (Exact Review correction)", async () => {
      const productBefore = await getProductById(db, productId);
      const draft = await generateDraft(db, productId, new StubProvider());
      expect(draft.baseProductUpdatedAt).toBe(productBefore.updatedAt);

      const approved = await approveDraft(db, draft.id, "admin-1");
      expect(approved.status).toBe(AiDraftStatus.Approved);

      const productAfter = await getProductById(db, productId);
      expect(productAfter.updatedAt).not.toBe(productBefore.updatedAt);
      expect(new Date(productAfter.updatedAt).getTime()).toBeGreaterThan(
        new Date(draft.baseProductUpdatedAt!).getTime(),
      );
    });

    it("a stale manual edit loaded before AI approval is rejected afterward, proving the Sprint 88 race is closed (Exact Review correction)", async () => {
      const draft = await generateDraft(db, productId, new StubProvider());
      // Simulates an editor who loaded the Product (and its version token) before approval happened.
      const staleTokenLoadedBeforeApproval = draft.baseProductUpdatedAt!;

      await approveDraft(db, draft.id, "admin-1");

      await expect(
        updateProduct(db, productId, {
          title: "Stale Manual Overwrite",
          expectedUpdatedAt: staleTokenLoadedBeforeApproval,
        }),
      ).rejects.toBeInstanceOf(ProductVersionConflictError);

      const productAfter = await getProductById(db, productId);
      expect(productAfter.title).toBe("Stub Generated Title");
      expect(productAfter.title).not.toBe("Stale Manual Overwrite");
    });
  });

  describe("Sprint 89: atomic claim behavior (deterministic, no timing dependency)", () => {
    it("repository: exactly one conditional claimAndApprove succeeds for the same draft id", async () => {
      const draft = await generateDraft(db, productId, new StubProvider());
      const repo = createDrizzleAiDraftApprovalRepository(db as any, sqliteSchema, "asynchronous");
      const reviewedAt = new Date().toISOString();
      const first = await repo.claimAndApprove({ id: draft.id, reviewedByAdminUserId: "admin-a", reviewedAt, updatedAt: reviewedAt });
      const second = await repo.claimAndApprove({ id: draft.id, reviewedByAdminUserId: "admin-b", reviewedAt, updatedAt: reviewedAt });
      expect(first.updated).toBe(true);
      expect(second.updated).toBe(false);
      expect(second.conflict?.field).toBe("status");
    });

    it("a second concurrent approval loses the atomic claim, receives AiDraftReviewConflictError, and never mutates the Product", async () => {
      const draft = await generateDraft(db, productId, new StubProvider());
      await approveDraft(db, draft.id, "admin-first");
      const productAfterFirst = await getProductById(db, productId);

      const capability = createAiDraftApprovalTransactionCapabilityForDb(db as any, "sqlite");
      const inventoryCtx = { clock: { now: () => new Date() }, idGenerator: { newId: () => "unused" } };
      // capability.run throws synchronously for the SQLite driver (matching db.transaction's own
      // synchronous-callback contract) - wrapped in an async IIFE so the throw becomes a proper
      // rejected promise for `.rejects` to capture, exactly as the `await` inside the real
      // `async function approveDraft` already does for every other caller of this use case.
      await expect(
        (async () =>
          approveAiListingDraftUseCase(capability, inventoryCtx, {
            id: draft.id,
            // Simulates a second request that read the draft as PendingReview before the first committed.
            status: AiDraftStatus.PendingReview,
            productId,
            baseProductUpdatedAt: draft.baseProductUpdatedAt!,
            reviewedByAdminUserId: "admin-second",
            productValues: { status: ProductStatus.Approved, title: "Should Never Apply" },
          }))(),
      ).rejects.toBeInstanceOf(AiDraftReviewConflictError);

      const productAfterSecond = await getProductById(db, productId);
      expect(productAfterSecond.updatedAt).toBe(productAfterFirst.updatedAt);
      expect(productAfterSecond.title).not.toBe("Should Never Apply");
    });
  });
});
