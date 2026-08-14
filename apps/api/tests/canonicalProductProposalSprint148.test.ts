import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import { addProductMarketingTag, listProductMarketingTags } from "../src/services/marketingTags";
import { createTestDb } from "./testDb";
import {
  CanonicalProductProposalGenerationInProgressError,
  CanonicalProductProposalNoSelectionError,
  CanonicalProductProposalNotPendingError,
  CanonicalProductProposalVersionConflictError,
  ProductVersionConflictError,
} from "../src/services/errors";
import { MockCanonicalProductProposalProvider } from "../src/canonical-product-ai/mockProvider";
import {
  tryAcquireCanonicalProductProposalGenerationGuard,
  releaseCanonicalProductProposalGenerationGuard,
} from "../src/use-cases/canonical-product-proposal/generationGuard";
import { acceptCanonicalProductProposalUseCase, generateCanonicalProductProposalUseCase } from "../src/use-cases/canonical-product-proposal/useCases";
import { createDrizzleCanonicalProductProposalRepository } from "../src/repositories/canonical-product-proposal/drizzle";
import { createCanonicalProductProposalApprovalTransactionCapabilityForDb } from "../src/services/canonicalProductProposalApprovalTransactionCapabilityForDb";
import {
  acceptCanonicalProductProposal,
  generateCanonicalProductProposal,
  getCurrentCanonicalProductProposal,
} from "../src/services/canonicalProductProposal";
import { canonicalProductAiProposals, productMarketingTags, marketingTags } from "../src/db/schema";

function stubProvider(proposal: Record<string, unknown> = {}) {
  return {
    generate: vi.fn(async (req: any) => ({
      proposal: { suggestedBrand: "Stub Brand", suggestedDescription: "Stub description.", ...proposal },
      metadata: { providerName: "stub-canonical-product-ai", promptVersion: req.prompt.version, imagesUsedCount: 0 },
    })),
  };
}

function noopPhotoReader() {
  return { read: vi.fn(async () => Buffer.from("")) };
}

describe("Sprint 148: Canonical Product AI Proposal", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let productId: string;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true })).id;
    const product = await createProduct(db, {
      sku: `CPP-${Math.random().toString(36).slice(2, 10)}`,
      title: "Moon Watch",
      description: "A rare vintage watch.",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      priceEur: 500,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
    } as any);
    productId = product.id;
  });

  function capability() {
    return createCanonicalProductProposalApprovalTransactionCapabilityForDb(db as any, "sqlite");
  }

  async function readyProposal(proposalFields: Record<string, unknown> = {}) {
    const repository = createDrizzleCanonicalProductProposalRepository(db);
    const product = await getProductById(db, productId);
    return generateCanonicalProductProposalUseCase(repository, stubProvider(proposalFields) as any, {
      productId,
      baseProductUpdatedAt: product.updatedAt,
      context: { productId, title: product.title, photos: [] },
      photoReader: noopPhotoReader() as any,
    });
  }

  describe("Generate", () => {
    it("persists a reviewable canonical proposal", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      expect(proposal.status).toBe("pending");
      const rows = await db.select().from(canonicalProductAiProposals);
      expect(rows).toHaveLength(1);
      expect(rows[0].suggestedBrand).toBe("Omega");
    });

    it("never mutates Product fields", async () => {
      const before = await getProductById(db, productId);
      await readyProposal({ suggestedBrand: "Omega", suggestedLengthValue: 10, suggestedDimensionUnit: "cm" });
      const after = await getProductById(db, productId);
      expect(after.brand ?? null).toBe(before.brand ?? null);
      expect(after.lengthValue ?? null).toBe(before.lengthValue ?? null);
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("never mutates Marketing Tags", async () => {
      await readyProposal({ suggestedMarketingTags: ["Father's Day"] });
      const tags = await listProductMarketingTags(db, productId);
      expect(tags).toHaveLength(0);
    });

    it("Regenerate refreshes the proposal in place with a fresh freshness token", async () => {
      const first = await readyProposal({ suggestedBrand: "Omega" });
      await new Promise((r) => setTimeout(r, 2));
      const second = await readyProposal({ suggestedBrand: "Rolex" });
      expect(second.id).toBe(first.id); // one row per productId, refreshed in place
      expect(second.updatedAt).not.toBe(first.updatedAt);
      const rows = await db.select().from(canonicalProductAiProposals);
      expect(rows).toHaveLength(1);
      expect(rows[0].suggestedBrand).toBe("Rolex");
    });

    it("rejects a second concurrent Generate for the same product while one is in flight", async () => {
      expect(tryAcquireCanonicalProductProposalGenerationGuard(productId)).toBe(true);
      try {
        const repository = createDrizzleCanonicalProductProposalRepository(db);
        const product = await getProductById(db, productId);
        await expect(
          generateCanonicalProductProposalUseCase(repository, stubProvider() as any, {
            productId,
            baseProductUpdatedAt: product.updatedAt,
            context: { productId, title: product.title, photos: [] },
            photoReader: noopPhotoReader() as any,
          }),
        ).rejects.toBeInstanceOf(CanonicalProductProposalGenerationInProgressError);
      } finally {
        releaseCanonicalProductProposalGenerationGuard(productId);
      }
    });

    it("Product Story is a supported suggested field", async () => {
      const proposal = await readyProposal({ suggestedProductStory: "A story." });
      expect(proposal.suggestedProductStory).toBe("A story.");
    });
  });

  describe("Accept (use-case level)", () => {
    it("applies only explicitly selected Product fields - an unselected suggested field is never written", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega", suggestedModel: "Speedmaster" });
      await acceptCanonicalProductProposalUseCase(capability(), {
        id: proposal.id as string,
        productId,
        expectedProposalUpdatedAt: proposal.updatedAt as string,
        actorId: "admin-1",
        selectedProductFields: ["brand"],
        selectedMarketingTags: [],
      });
      const after = await getProductById(db, productId);
      expect(after.brand).toBe("Omega");
      expect(after.model ?? null).toBeNull(); // model was suggested but never selected
    });

    it("arbitrary/unknown client field names cannot escape the server allowlist", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      await acceptCanonicalProductProposalUseCase(capability(), {
        id: proposal.id as string,
        productId,
        expectedProposalUpdatedAt: proposal.updatedAt as string,
        actorId: "admin-1",
        selectedProductFields: ["brand", "sku", "status", "stockQuantity", "__proto__"],
        selectedMarketingTags: [],
      });
      const after = await getProductById(db, productId);
      expect(after.brand).toBe("Omega"); // the one legitimate, allowlisted, suggested field still applied
      expect(after.status).toBe(ProductStatus.Draft); // never touched despite being requested
    });

    it("throws CanonicalProductProposalNoSelectionError when nothing is selected", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      await expect(
        acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string,
          productId,
          expectedProposalUpdatedAt: proposal.updatedAt as string,
          actorId: "admin-1",
          selectedProductFields: [],
          selectedMarketingTags: [],
        }),
      ).rejects.toBeInstanceOf(CanonicalProductProposalNoSelectionError);
    });

    it("rejects an Accept whose expectedProposalUpdatedAt no longer matches (stale proposal token)", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      await expect(
        acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string,
          productId,
          expectedProposalUpdatedAt: "not-the-real-value",
          actorId: "admin-1",
          selectedProductFields: ["brand"],
          selectedMarketingTags: [],
        }),
      ).rejects.toBeInstanceOf(CanonicalProductProposalVersionConflictError);
    });

    it("an old proposal freshness token cannot Accept a regenerated proposal", async () => {
      const first = await readyProposal({ suggestedBrand: "Omega" });
      await new Promise((r) => setTimeout(r, 2));
      await readyProposal({ suggestedBrand: "Rolex" }); // regenerate - new updatedAt
      await expect(
        acceptCanonicalProductProposalUseCase(capability(), {
          id: first.id as string,
          productId,
          expectedProposalUpdatedAt: first.updatedAt as string, // the OLD token
          actorId: "admin-1",
          selectedProductFields: ["brand"],
          selectedMarketingTags: [],
        }),
      ).rejects.toBeInstanceOf(CanonicalProductProposalVersionConflictError);
    });

    it("rejects Accept when the Product changed since generation (Product optimistic-concurrency gate)", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      await updateProduct(db, productId, { title: "A New Title", expectedUpdatedAt: (await getProductById(db, productId)).updatedAt } as any);
      await expect(
        acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string,
          productId,
          expectedProposalUpdatedAt: proposal.updatedAt as string,
          actorId: "admin-1",
          selectedProductFields: ["brand"],
          selectedMarketingTags: [],
        }),
      ).rejects.toBeInstanceOf(ProductVersionConflictError);
    });

    it("an already-Applied proposal cannot mutate the Product again", async () => {
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      await acceptCanonicalProductProposalUseCase(capability(), {
        id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
        selectedProductFields: ["brand"], selectedMarketingTags: [],
      });
      await expect(
        acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
          selectedProductFields: ["brand"], selectedMarketingTags: [],
        }),
      ).rejects.toBeInstanceOf(CanonicalProductProposalNotPendingError);
    });

    it("never mutates SKU or Product status", async () => {
      const before = await getProductById(db, productId);
      const proposal = await readyProposal({ suggestedBrand: "Omega" });
      await acceptCanonicalProductProposalUseCase(capability(), {
        id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
        selectedProductFields: ["brand"], selectedMarketingTags: [],
      });
      const after = await getProductById(db, productId);
      expect(after.sku).toBe(before.sku);
      expect(after.status).toBe(before.status);
    });

    it("weightUnit is applied and persisted as the correct string enum value", async () => {
      const proposal = await readyProposal({ suggestedWeightValue: 1.2, suggestedWeightUnit: "kg" });
      await acceptCanonicalProductProposalUseCase(capability(), {
        id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
        selectedProductFields: ["weightValue", "weightUnit"], selectedMarketingTags: [],
      });
      const after = await getProductById(db, productId);
      expect(after.weightUnit).toBe("kg");
      expect(after.weightValue).toBe(1.2);
    });

    describe("Marketing Tags - additive only", () => {
      it("only explicitly selected suggested tags are added, existing tags are preserved, duplicates are canonicalized/deduped", async () => {
        await addProductMarketingTag(db, productId, "Vintage");
        const proposal = await readyProposal({ suggestedMarketingTags: ["Father's Day", "Vintage", "Anniversary"] });
        await acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
          selectedProductFields: [], selectedMarketingTags: ["Father's Day", "Vintage"], // "Anniversary" deliberately NOT selected
        });
        const tags = await listProductMarketingTags(db, productId);
        const labels = tags.map((t) => t.label).sort();
        expect(labels).toEqual(["Father's Day", "Vintage"].sort()); // "Vintage" not duplicated, "Anniversary" not added
      });

      it("an arbitrary client-supplied tag not present in the proposal's own suggestions is never added", async () => {
        const proposal = await readyProposal({ suggestedMarketingTags: ["Father's Day"] });
        await acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
          selectedProductFields: [], selectedMarketingTags: ["Hacked Tag"],
        });
        const tags = await listProductMarketingTags(db, productId);
        expect(tags).toHaveLength(0);
      });

      it("never touches Etsy Tags", async () => {
        const proposal = await readyProposal({ suggestedMarketingTags: ["Father's Day"] });
        await acceptCanonicalProductProposalUseCase(capability(), {
          id: proposal.id as string, productId, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
          selectedProductFields: [], selectedMarketingTags: ["Father's Day"],
        });
        const after = await getProductById(db, productId);
        expect(after.etsyTags ?? null).toBeNull();
      });
    });

    it("atomic rollback: a forced failure during the Product update rolls back the whole Accept - proposal stays Pending, no Marketing Tag is added", async () => {
      const Database = (await import("better-sqlite3")).default;
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const sqliteSchema = await import("../src/db/schema.sqlite");
      const { ensureSchema } = await import("../src/db/migrate");

      const sqlite = new Database(":memory:");
      sqlite.pragma("foreign_keys = ON");
      ensureSchema(sqlite);
      const localDb = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;

      const localCategoryId = (await createCategory(localDb, { name: "Watches", displayOrder: 0, isActive: true })).id;
      const localProduct = await createProduct(localDb, {
        sku: `CPP-ROLLBACK-${Math.random().toString(36).slice(2, 8)}`,
        title: "Rollback Watch",
        type: ProductType.UniqueItem,
        status: ProductStatus.Draft,
        categoryId: localCategoryId,
        priceEur: 500,
        customsWarning: false,
        isFeatured: false,
        allowMakeOffer: false,
        allowCashOnDelivery: false,
        showInArchiveAfterSale: false,
      } as any);

      const repository = createDrizzleCanonicalProductProposalRepository(localDb);
      const proposal = await generateCanonicalProductProposalUseCase(repository, stubProvider({ suggestedBrand: "Omega", suggestedMarketingTags: ["Vintage"] }) as any, {
        productId: localProduct.id,
        baseProductUpdatedAt: localProduct.updatedAt,
        context: { productId: localProduct.id, title: localProduct.title, photos: [] },
        photoReader: noopPhotoReader() as any,
      });

      sqlite.exec("CREATE TRIGGER fail_canonical_ai_product_update AFTER UPDATE OF brand ON products BEGIN SELECT RAISE(ABORT,'forced failure'); END;");

      const localCapability = createCanonicalProductProposalApprovalTransactionCapabilityForDb(localDb as any, "sqlite");
      await expect(
        acceptCanonicalProductProposalUseCase(localCapability, {
          id: proposal.id as string,
          productId: localProduct.id,
          expectedProposalUpdatedAt: proposal.updatedAt as string,
          actorId: "admin-1",
          selectedProductFields: ["brand"],
          selectedMarketingTags: ["Vintage"],
        }),
      ).rejects.toThrow();

      const currentProposal = (await repository.findByProductId(localProduct.id))!;
      expect(currentProposal.status).toBe("pending"); // the claim was rolled back together with the failed Product update
      const tagsAfter = await localDb.select().from(productMarketingTags);
      expect(tagsAfter).toHaveLength(0); // the Marketing Tag relation never committed either

      sqlite.close();
    });
  });

  describe("service layer (generateCanonicalProductProposal / getCurrentCanonicalProductProposal / acceptCanonicalProductProposal)", () => {
    it("generateCanonicalProductProposal reads the canonical Product fresh via getProductById", async () => {
      const spy = vi.spyOn(await import("../src/services/products"), "getProductById");
      await generateCanonicalProductProposal(db, productId, new MockCanonicalProductProposalProvider());
      expect(spy).toHaveBeenCalledWith(db, productId);
    });

    it("getCurrentCanonicalProductProposal 404s when no proposal has been generated yet", async () => {
      await expect(getCurrentCanonicalProductProposal(db, productId)).rejects.toThrow();
    });

    it("acceptCanonicalProductProposal returns the current canonical Product with only the selected fields applied", async () => {
      await generateCanonicalProductProposal(db, productId, stubProvider({ suggestedBrand: "Omega" }) as any);
      const proposal = await getCurrentCanonicalProductProposal(db, productId);
      const product = await acceptCanonicalProductProposal(
        db,
        productId,
        { expectedProposalUpdatedAt: proposal.updatedAt, selectedProductFields: ["brand"], selectedMarketingTags: [] },
        "admin-1",
      );
      expect(product.brand).toBe("Omega");
    });
  });
});
