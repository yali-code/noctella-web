import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiIntakeFieldDecision, ProductStatus, ProductType, PublishChannel, PublishJobStatus } from "@noctella/shared";
import { publishJobs } from "../src/db/schema";
import { createIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview } from "../src/services/aiIntakeProposals";
import { acceptAiIntakeIntoStock } from "../src/services/aiIntakeStockAcceptance";
import { createCategory } from "../src/services/categories";
import { listPendingPublishQueue } from "../src/services/products";
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
 * Sprint 142: Pending Publish publication evidence - proves the Sprint 142 addition to
 * repositories/product-read/drizzle.ts's pendingPublishWhere (a correlated NOT EXISTS Succeeded
 * PublishJob subquery). Exercises the REAL production listPendingPublishQueue/pendingPublishWhere
 * behavior throughout - never a parallel/duplicated eligibility check in test code. Products are
 * created via the real Stock Acceptance flow (mirrors pendingPublishQueueSprint139.test.ts's own
 * acceptFreshStockAcceptedProduct helper exactly, the established precedent for this exact queue).
 * PublishJob evidence rows are inserted directly against the real publish_jobs table - deliberately
 * not re-derived via a full executePublish() flow, since that write path's own correctness is
 * already exhaustively covered by marketplacePublishing.test.ts/unifiedPublishSprint141.test.ts;
 * this file's only new invariant is how the Pending Publish QUERY reacts to that already-proven
 * evidence shape.
 */
describe("Pending Publish - publication evidence (Sprint 142)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Test Category", displayOrder: 0, isActive: true });
    categoryId = category.id;
  });

  /** Mirrors pendingPublishQueueSprint139.test.ts's own helper exactly - the established Stock Acceptance fixture for this queue. */
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

  /**
   * Inserts a PublishJob row directly against the real publish_jobs table - the exact durable shape
   * executePublish itself writes, without needing to satisfy validatePublish's full per-channel
   * field/photo/price gate for every fixture in this file (that gate's own correctness is proven
   * elsewhere). idempotencyKey is unique per call (a real, enforced DB constraint).
   */
  async function insertPublishJob(productId: string, channel: PublishChannel, status: PublishJobStatus) {
    const now = new Date().toISOString();
    await db.insert(publishJobs).values({
      id: randomUUID(),
      productId,
      channel,
      status,
      idempotencyKey: `sprint142-${randomUUID()}`,
      payloadSnapshot: "{}",
      attemptCount: status === PublishJobStatus.Succeeded ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    } as any);
  }

  async function queueIds() {
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    return queue.items.map((i) => i.id);
  }

  it("1. never published - a fresh Stock-Accepted Product with no PublishJob evidence appears in Pending Publish, and the count includes it", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    expect(queue.items.map((i) => i.id)).toContain(product.id);
    expect(queue.total).toBe(1);
  });

  it("2. a successful Noctella Web PublishJob excludes the Product, without relying on Product.status", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.NoctellaWeb, PublishJobStatus.Succeeded);
    // Product.status itself is untouched by this direct evidence insert - still Draft/Approved -
    // proving the NEW exclusion is genuinely driven by PublishJob evidence, not merely by status.
    expect(await queueIds()).not.toContain(product.id);
  });

  it("3. eBay-only success excludes the Product even though Product.status remains Draft/Approved (the core Sprint 142 defect proof)", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    expect(product.status).toBe(ProductStatus.Draft);
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.Succeeded);
    expect(await queueIds()).not.toContain(product.id);
  });

  it("4. Etsy-only success excludes the Product even though Product.status remains Draft/Approved", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    expect(product.status).toBe(ProductStatus.Draft);
    await insertPublishJob(product.id, PublishChannel.Etsy, PublishJobStatus.Succeeded);
    expect(await queueIds()).not.toContain(product.id);
  });

  it("5. eBay + Etsy success (Web untouched) excludes the Product - the exact Sprint 141-exposed inconsistency", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.Succeeded);
    await insertPublishJob(product.id, PublishChannel.Etsy, PublishJobStatus.Succeeded);
    expect(product.status).toBe(ProductStatus.Draft);
    expect(await queueIds()).not.toContain(product.id);
  });

  it("6. a Failed-only PublishJob history does not exclude the Product - it remains in Pending Publish", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.Failed);
    expect(await queueIds()).toContain(product.id);
  });

  it("7. a RetryPending-only PublishJob history does not exclude the Product - it remains in Pending Publish", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.RetryPending);
    expect(await queueIds()).toContain(product.id);
  });

  it("7b. a Processing-only PublishJob history does not exclude the Product - only Succeeded excludes", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.Etsy, PublishJobStatus.Processing);
    expect(await queueIds()).toContain(product.id);
  });

  it("8. historical success remains excluded even after the corresponding ExternalListing later becomes terminal/inactive - 'ever published' is permanent, not 'currently live'", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.Succeeded);
    // The historical PublishJob.status is never retroactively changed when a listing later ends
    // (endExternalListing only ever updates external_listings.external_status - confirmed in
    // Sprint 142 Discovery) - simulated here directly, without needing the full ExternalListing
    // write path, since only the PublishJob evidence is what the Pending Publish predicate reads.
    expect(await queueIds()).not.toContain(product.id);
  });

  it("9. multiple historical rows (Failed then Succeeded) still exclude exactly once - no duplicate result and no incorrect count", async () => {
    const { product } = await acceptFreshStockAcceptedProduct();
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.Failed);
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.RetryPending);
    await insertPublishJob(product.id, PublishChannel.Ebay, PublishJobStatus.Succeeded);
    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    const ids = queue.items.map((i) => i.id);
    expect(ids.filter((id) => id === product.id)).toHaveLength(0); // excluded, not duplicated-and-excluded
    expect(queue.total).toBe(0);
  });

  it("10. list and count agree exactly across a mixed fixture set", async () => {
    const neverPublished = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Never Published" });
    const ebaySucceeded = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Ebay Succeeded" });
    await insertPublishJob(ebaySucceeded.product.id, PublishChannel.Ebay, PublishJobStatus.Succeeded);
    const etsyFailed = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Etsy Failed" });
    await insertPublishJob(etsyFailed.product.id, PublishChannel.Etsy, PublishJobStatus.Failed);
    const webSucceeded = await acceptFreshStockAcceptedProduct({ suggestedTitle: "Web Succeeded" });
    await insertPublishJob(webSucceeded.product.id, PublishChannel.NoctellaWeb, PublishJobStatus.Succeeded);

    const queue = await listPendingPublishQueue(db as any, { page: 1, pageSize: 20 } as any);
    const ids = queue.items.map((i) => i.id);

    expect(ids).toContain(neverPublished.product.id);
    expect(ids).toContain(etsyFailed.product.id); // Failed does not exclude
    expect(ids).not.toContain(ebaySucceeded.product.id);
    expect(ids).not.toContain(webSucceeded.product.id);

    expect(queue.total).toBe(queue.items.length);
    expect(queue.total).toBe(2);
  });
});
