import { AiDraftStatus, ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiListingGenerationInput, AiListingGenerationResult, AiListingProvider } from "../src/ai/provider";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";
import { BadRequestError } from "../src/services/errors";
import {
  approveDraft,
  generateDraft,
  getDraftById,
  listDrafts,
  regenerateDraft,
  rejectDraft,
  updateDraft,
} from "../src/services/aiDrafts";
import { createTestDb } from "./testDb";

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
    await approveDraft(db, draft.id);

    const product = await getProductById(db, productWithInternals.id);
    expect(product.sku).toBe("SKU-AI-002");
    expect(product.purchaseCost).toBe(200);
    expect(product.stockQuantity).toBe(1);
    expect(product.internalNotes).toBe("Bought from estate sale, do not discount.");
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
    await approveDraft(db, draft.id);
    await expect(approveDraft(db, draft.id)).rejects.toBeInstanceOf(BadRequestError);
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
});
