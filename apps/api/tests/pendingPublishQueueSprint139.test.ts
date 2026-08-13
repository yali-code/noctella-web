import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiIntakeFieldDecision, ProductStatus, ProductType } from "@noctella/shared";
import { createIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview } from "../src/services/aiIntakeProposals";
import { acceptAiIntakeIntoStock } from "../src/services/aiIntakeStockAcceptance";
import { createCategory } from "../src/services/categories";
import { archiveProduct, createProduct, getProductById, listPendingPublishQueue, updateProduct } from "../src/services/products";
import type { AiIntakeGenerationProvider } from "../src/ai-intake/types";
import { createTestDb } from "./testDb";

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

/**
 * Sprint 139: Pending Publish queue - the eligibility read model
 * (services/products.ts's listPendingPublishQueue, backed by
 * repositories/product-read/drizzle.ts's listPendingPublish/countPendingPublish). Proves
 * membership is genuine Warehouse Stock Acceptance provenance (an ai_product_intakes row whose
 * resultProductId resolves to the Product and whose appliedAt is non-null), not "any Draft
 * Product" and not a persisted status - exactly the approved eligibility contract.
 */
describe("Pending Publish queue (Sprint 139)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Test Category", displayOrder: 0, isActive: true });
    categoryId = category.id;
  });

  /**
   * Runs a full Stock Acceptance (intake -> proposal -> title review -> accept) and returns the
   * resulting Product + intake. `forCategoryId` defaults to the shared beforeEach category; the
   * Category filter tests below pass a second, distinct category explicitly.
   */
  async function acceptFreshStockAcceptedProduct(overrides: Record<string, unknown> = {}, forCategoryId: string = categoryId) {
    const intake = await createIntake(db as any, "admin-1");
    const generated = await generateIntakeProposal(db as any, intake.id, stubProvider(overrides));
    const reviewed = await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
    const result = await acceptAiIntakeIntoStock(
      db as any,
      intake.id,
      { categoryId: forCategoryId, type: ProductType.UniqueItem, priceEur: 42, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
      "admin-3",
    );
    const finalIntake = await getIntakeById(db as any, intake.id);
    return { product: result.product, intake: finalIntake };
  }

  function baseManualInput(overrides: Record<string, unknown> = {}) {
    return {
      sku: "SKU-MANUAL-001",
      title: "Manually Created Draft",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
      ...overrides,
    };
  }

  it("1. a fresh Stock-Accepted Draft Product appears", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    expect(product.status).toBe(ProductStatus.Draft);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.items.map((i) => i.id)).toContain(product.id);
  });

  it("2. a Stock-Accepted Approved Product remains eligible", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await updateProduct(db as any, product.id, { status: ProductStatus.Approved } as any);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.items.map((i) => i.id)).toContain(product.id);
  });

  it("3. an arbitrary Draft Product with no Stock Acceptance provenance does NOT appear", async () => {
    const manual = await createProduct(db as any, baseManualInput() as any);
    expect(manual.status).toBe(ProductStatus.Draft);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.items.map((i) => i.id)).not.toContain(manual.id);
  });

  it("4. a Published Product with Stock Acceptance provenance does NOT appear", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await updateProduct(db as any, product.id, { status: ProductStatus.Published } as any);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.items.map((i) => i.id)).not.toContain(product.id);
  });

  it("5. an Archived Product with Stock Acceptance provenance does NOT appear", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await archiveProduct(db as any, product.id);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.items.map((i) => i.id)).not.toContain(product.id);
  });

  it("6. Stock Accepted is derived from the intake's appliedAt, never Product createdAt", async () => {
    const { product, intake } = await acceptFreshStockAcceptedProduct();
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    const row = queue.items.find((i) => i.id === product.id)!;
    expect(row.stockAcceptedAt).toBe(intake!.appliedAt);
  });

  it("9. loading the queue does not mutate the Product (status/updatedAt untouched)", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    const before = await getProductById(db as any, product.id);
    await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    const after = await getProductById(db as any, product.id);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("10. no duplicate rows are returned - two distinct Stock-Accepted Products yield exactly two rows", async () => {
    const first = await acceptFreshStockAcceptedProduct({ suggestedTitle: "First Item" });
    const second = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Second Item" });
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    const ids = queue.items.map((i) => i.id);
    expect(ids.filter((id) => id === first.product.id)).toHaveLength(1);
    expect(ids.filter((id) => id === second.product.id)).toHaveLength(1);
  });

  it("11. the count uses the identical eligibility semantics as the list - they never disagree", async () => {
    await acceptFreshStockAcceptedProduct({ suggestedTitle: "Counted Item" });
    await createProduct(db as any, baseManualInput({ sku: "SKU-MANUAL-002", title: "Uncounted Manual Draft" }) as any);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.total).toBe(queue.items.length);
    expect(queue.total).toBe(1);
  });
});

/**
 * Sprint 139 Required Fix #1: optional Category filter on the Pending Publish read model.
 * Proves categoryId ANDs with (never replaces) the same Stock Acceptance provenance/status
 * eligibility exercised above - the exact backend requirement from the Required Fix contract.
 */
describe("Pending Publish queue - optional Category filter (Sprint 139 Required Fix #1)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let otherCategoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Cameras", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const otherCategory = await createCategory(db, { name: "Watches", displayOrder: 1, isActive: true });
    otherCategoryId = otherCategory.id;
  });

  async function acceptFreshStockAcceptedProduct(overrides: Record<string, unknown> = {}, forCategoryId: string = categoryId) {
    const intake = await createIntake(db as any, "admin-1");
    const generated = await generateIntakeProposal(db as any, intake.id, stubProvider(overrides));
    const reviewed = await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
    const result = await acceptAiIntakeIntoStock(
      db as any,
      intake.id,
      { categoryId: forCategoryId, type: ProductType.UniqueItem, priceEur: 42, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
      "admin-3",
    );
    return { product: result.product };
  }

  function baseManualInput(overrides: Record<string, unknown> = {}) {
    return {
      sku: "SKU-MANUAL-CAT-001",
      title: "Manually Created Draft",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 100,
      ...overrides,
    };
  }

  it("9. no categoryId filter preserves the existing eligibility (both categories' Stock-Accepted Products appear)", async () => {
    const a = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Camera Item" }, categoryId);
    const b = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Watch Item" }, otherCategoryId);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    const ids = queue.items.map((i) => i.id);
    expect(ids).toContain(a.product.id);
    expect(ids).toContain(b.product.id);
  });

  it("10. categoryId filters to eligible Stock-Accepted Draft/Approved Products in that Category only", async () => {
    const inCategory = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Camera Item" }, categoryId);
    const otherCategory = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Watch Item" }, otherCategoryId);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20, categoryId } as any);
    const ids = queue.items.map((i) => i.id);
    expect(ids).toContain(inCategory.product.id);
    expect(ids).not.toContain(otherCategory.product.id);
  });

  it("11. an arbitrary Draft Product (no Stock Acceptance provenance) in the selected Category remains excluded", async () => {
    const manual = await createProduct(db as any, baseManualInput() as any);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20, categoryId } as any);
    expect(queue.items.map((i) => i.id)).not.toContain(manual.id);
  });

  it("12. a Published/Archived Product in the selected Category remains excluded", async () => {
    const published = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Published Camera" }, categoryId);
    await updateProduct(db as any, published.product.id, { status: ProductStatus.Published } as any);
    const archived = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Archived Camera" }, categoryId);
    await archiveProduct(db as any, archived.product.id);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20, categoryId } as any);
    const ids = queue.items.map((i) => i.id);
    expect(ids).not.toContain(published.product.id);
    expect(ids).not.toContain(archived.product.id);
  });

  it("13. Products in other Categories are excluded from a Category-filtered query", async () => {
    const otherCategory = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Watch Item" }, otherCategoryId);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20, categoryId } as any);
    expect(queue.items.map((i) => i.id)).not.toContain(otherCategory.product.id);
  });

  it("14. the count reflects the Category filter consistently with the list", async () => {
    await acceptFreshStockAcceptedProduct({ suggestedTitle: "Camera Item" }, categoryId);
    await acceptFreshStockAcceptedProduct({ suggestedTitle: "Watch Item" }, otherCategoryId);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20, categoryId } as any);
    expect(queue.total).toBe(queue.items.length);
    expect(queue.total).toBe(1);
  });
});
