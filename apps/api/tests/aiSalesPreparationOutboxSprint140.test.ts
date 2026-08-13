import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { AiIntakeFieldDecision, AiProductIntakeStatus, ProductStatus, ProductType, PublishChannel } from "@noctella/shared";
import { createIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview } from "../src/services/aiIntakeProposals";
import { acceptAiIntakeIntoStock } from "../src/services/aiIntakeStockAcceptance";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import * as productsModule from "../src/services/products";
import { outboxEvents, products, productSkuSequence, stockMovements } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { AiSalesPreparationHandler, aiSalesPreparationIdempotencyKey } from "../src/services/aiSalesPreparationOutbox";
import * as aiSalesPreparationOutboxModule from "../src/services/aiSalesPreparationOutbox";
import { createDrizzleMarketplacePreparationRepository, createDrizzleMarketplacePreparationApprovalRepository } from "../src/repositories/marketplace-preparation/drizzle";
import { MockMarketplacePreparationProvider } from "../src/marketplace-prep/mockProvider";
import type { MarketplacePreparationProvider } from "../src/marketplace-prep/types";
import type { AiIntakeGenerationProvider } from "../src/ai-intake/types";
import { eq } from "drizzle-orm";
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

/** Fails generation for exactly one channel, succeeds (via the deterministic Mock) for the others. */
function providerThatFailsOneChannel(failingChannel: PublishChannel): MarketplacePreparationProvider {
  const mock = new MockMarketplacePreparationProvider();
  return {
    async generate(request) {
      if (request.context.channel === failingChannel) throw new Error("Simulated provider failure");
      return mock.generate(request);
    },
  };
}

describe("Transactional AI Sales Preparation Outbox (Sprint 140)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let intakeId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Test Category", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  async function readyIntake(suggestions: Record<string, unknown> = {}) {
    const generated = await generateIntakeProposal(db as any, intakeId, stubProvider(suggestions));
    return updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
  }

  it("a successful NEW Stock Acceptance commits a durable AiSalesPreparationRequested event atomically alongside the Product, with the correct payload/idempotency key", async () => {
    // Isolates the transactional insert from the immediate post-commit dispatch (mocked to a
    // no-op here) so the event's raw as-committed state can be inspected directly - the more
    // precise proof that the durable intent exists atomically with Product/Inventory/SKU,
    // independent of whether/when dispatch happens to run.
    const dispatchSpy = vi.spyOn(aiSalesPreparationOutboxModule, "dispatchDueAiSalesPreparationOutboxEvents").mockResolvedValue([] as any);
    const proposal = await readyIntake();
    const result = await acceptAiIntakeIntoStock(
      db as any,
      intakeId,
      { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
      "admin-3",
    );
    expect(result.created).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith(db, "post-commit", 1);

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, aiSalesPreparationIdempotencyKey(result.product.id)));
    expect(event).toBeDefined();
    expect(event.eventType).toBe(OutboxEventType.AiSalesPreparationRequested);
    expect(event.aggregateType).toBe("Product");
    expect(event.aggregateId).toBe(result.product.id);
    expect(event.status).toBe(OutboxEventStatus.Pending);

    const payload = JSON.parse(event.payload as string);
    expect(payload).toEqual({ productId: result.product.id, intakeId });
    dispatchSpy.mockRestore();
  });

  it("the immediate post-commit dispatch actually processes the just-committed event end-to-end (all three channels prepared, event Succeeded)", async () => {
    const proposal = await readyIntake();
    const result = await acceptAiIntakeIntoStock(
      db as any,
      intakeId,
      { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
      "admin-3",
    );

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, aiSalesPreparationIdempotencyKey(result.product.id)));
    expect(event.status).toBe(OutboxEventStatus.Succeeded);

    const repo = createDrizzleMarketplacePreparationRepository(db as any);
    for (const channel of [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy]) {
      expect(await repo.findByProductIdAndChannel(result.product.id, channel)).not.toBeNull();
    }
  });

  it("uses the deterministic ai-sales-preparation:<productId> idempotency key", async () => {
    const proposal = await readyIntake();
    const result = await acceptAiIntakeIntoStock(
      db as any,
      intakeId,
      { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
      "admin-3",
    );
    expect(aiSalesPreparationIdempotencyKey(result.product.id)).toBe(`ai-sales-preparation:${result.product.id}`);
  });

  it("a retried call for an already-Applied intake does not create a second Outbox event", async () => {
    const proposal = await readyIntake();
    const first = await acceptAiIntakeIntoStock(
      db as any,
      intakeId,
      { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
      "admin-3",
    );
    expect(first.created).toBe(true);

    const second = await acceptAiIntakeIntoStock(
      db as any,
      intakeId,
      { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
      "admin-3",
    );
    expect(second.created).toBe(false);
    expect(second.product.id).toBe(first.product.id);

    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, aiSalesPreparationIdempotencyKey(first.product.id)));
    expect(events).toHaveLength(1); // no duplicate event from the idempotent retry
  });

  it("a post-commit immediate dispatch failure does not roll back or affect the already-committed Stock Acceptance", async () => {
    const proposal = await readyIntake();
    // The immediate dispatch call inside acceptAiIntakeIntoStock is wrapped in .catch(()=>undefined) -
    // even a hard dispatcher failure (e.g. an unrelated DB hiccup during the post-commit sweep) must
    // never surface as a Stock Acceptance failure, since the transaction already committed before
    // this call is ever reached.
    const dispatchSpy = vi.spyOn(aiSalesPreparationOutboxModule, "dispatchDueAiSalesPreparationOutboxEvents").mockRejectedValue(new Error("Simulated dispatch failure"));
    const result = await acceptAiIntakeIntoStock(
      db as any,
      intakeId,
      { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
      "admin-3",
    );
    expect(result.created).toBe(true);
    // Product/Inventory/SKU genuinely committed despite the dispatch failure.
    const product = await getProductById(db as any, result.product.id);
    expect(product.id).toBe(result.product.id);
    dispatchSpy.mockRestore();
  });
});

/**
 * Sprint 140 Formal Validation Required Fix 1: a forced failure of the transactional
 * AiSalesPreparationRequested Outbox INSERT must roll back the entire authoritative NEW Stock
 * Acceptance transaction. Reuses the exact SQLite trigger fault-injection precedent already
 * established in aiIntakeStockAcceptance.test.ts's own "atomic rollback" describe block
 * (RAISE(ABORT,'forced failure') on AFTER INSERT), targeted here at outbox_events specifically -
 * requires a raw sqlite/drizzle instance (not createTestDb()) so the trigger can be installed
 * directly, mirroring that neighboring file's own setup exactly.
 */
describe("Transactional AI Sales Preparation Outbox - forced Outbox insert failure rollback (Sprint 140 Formal Validation Required Fix 1)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let intakeId: string;

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

  it("a forced outbox_events insert failure rolls back Product, StockMovement, SKU sequence, and intake-Applied provenance together - nothing commits", async () => {
    const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
    const proposal = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);

    // Forces the exact INSERT this Sprint's own enqueueAiSalesPreparationInTransaction performs to
    // fail with a genuine SQLite-level error, inside the same transaction as Product/Inventory/SKU.
    sqlite
      .prepare("CREATE TRIGGER fail_outbox_events_insert_140 AFTER INSERT ON outbox_events BEGIN SELECT RAISE(ABORT,'forced failure'); END;")
      .run();

    await expect(
      acceptAiIntakeIntoStock(
        db as any,
        intakeId,
        { categoryId, type: ProductType.UniqueItem, expectedProposalUpdatedAt: proposal.updatedAt } as any,
        "admin-3",
      ),
    ).rejects.toThrow();

    // 1. Product created by the attempted Stock Acceptance does NOT persist.
    expect(await db.select().from(products)).toHaveLength(0);
    // 2. Inventory (StockMovement, the canonical inventory-affecting write) does NOT persist.
    expect(await db.select().from(stockMovements)).toHaveLength(0);
    // 3. SKU allocation does NOT persist - the sequence row the allocation would have created was
    // rolled back too, so the very next successful acceptance still receives NOC-000001.
    expect(await db.select().from(productSkuSequence)).toHaveLength(0);
    // 4/5. AI Intake is NOT left Applied - Stock Acceptance / AI Intake Applied provenance was not committed.
    const intake = await getIntakeById(db as any, intakeId);
    expect(intake.status).toBe(AiProductIntakeStatus.Open);
    expect(intake.resultProductId).toBeUndefined();
    // 6. The AiSalesPreparationRequested Outbox event itself was rolled back along with everything else.
    const events = await db.select().from(outboxEvents);
    expect(events.filter((e: any) => e.eventType === OutboxEventType.AiSalesPreparationRequested)).toHaveLength(0);
  });
});

describe("AiSalesPreparationHandler - channel auto-generation (Sprint 140)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let productId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Test Category", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const product = await createProduct(db, {
      sku: "SKU-OUTBOX-001",
      title: "Test Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: null,
    } as any);
    productId = product.id;
  });

  function event(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    return {
      id: "event-1",
      eventType: OutboxEventType.AiSalesPreparationRequested,
      aggregateType: "Product",
      aggregateId: productId,
      idempotencyKey: aiSalesPreparationIdempotencyKey(productId),
      payload: { productId },
      status: OutboxEventStatus.Pending,
      attemptCount: 0,
      maxAttempts: 5,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as any;
  }

  it("generates all three channels when none exist yet", async () => {
    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    await handler.handle(event());

    const repo = createDrizzleMarketplacePreparationRepository(db as any);
    for (const channel of [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy]) {
      const row = await repo.findByProductIdAndChannel(productId, channel);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("pending");
    }
  });

  it("skips a channel that already has a pending preparation - never regenerates it", async () => {
    const repo = createDrizzleMarketplacePreparationRepository(db as any);
    await repo.upsert({
      id: "existing-web-prep",
      productId,
      channel: PublishChannel.NoctellaWeb,
      baseProductUpdatedAt: new Date().toISOString(),
      suggestedTitle: "Admin-visible existing suggestion",
      suggestedDescription: null,
      suggestedConditionDescription: null,
      suggestedItemSpecifics: null,
      suggestedTags: null,
      suggestedMaterials: null,
      suggestedStyle: null,
      suggestedOccasion: null,
      suggestedShortDescription: null,
      suggestedSeoTitle: null,
      suggestedMetaDescription: null,
      suggestedFocusKeyword: null,
      providerName: "manual-admin-trigger",
      promptVersion: "v1",
      generatedAt: new Date().toISOString(),
    });

    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    await handler.handle(event());

    const row = await repo.findByProductIdAndChannel(productId, PublishChannel.NoctellaWeb);
    expect(row!.suggestedTitle).toBe("Admin-visible existing suggestion"); // untouched, never regenerated
    expect(row!.providerName).toBe("manual-admin-trigger");
  });

  it("skips a channel that is already Applied - automatic processing never performs applied -> pending", async () => {
    const repo = createDrizzleMarketplacePreparationRepository(db as any);
    const upserted = await repo.upsert({
      id: "existing-etsy-prep",
      productId,
      channel: PublishChannel.Etsy,
      baseProductUpdatedAt: new Date().toISOString(),
      suggestedTitle: "Human-approved title",
      suggestedDescription: null,
      suggestedConditionDescription: null,
      suggestedItemSpecifics: null,
      suggestedTags: null,
      suggestedMaterials: null,
      suggestedStyle: null,
      suggestedOccasion: null,
      suggestedShortDescription: null,
      suggestedSeoTitle: null,
      suggestedMetaDescription: null,
      suggestedFocusKeyword: null,
      providerName: "mock-marketplace-prep-v1",
      promptVersion: "v1",
      generatedAt: new Date().toISOString(),
    });
    // Simulate the existing, unchanged human approval path having already applied it.
    const approvalRepo = createDrizzleMarketplacePreparationApprovalRepository(db as any, sqliteSchema, "asynchronous");
    await (approvalRepo as any).claimAndApprove({ id: upserted.id, appliedAt: new Date().toISOString(), appliedByAdminUserId: "admin-1", updatedAt: new Date().toISOString() });

    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    await handler.handle(event());

    const row = await repo.findByProductIdAndChannel(productId, PublishChannel.Etsy);
    expect(row!.status).toBe("applied"); // never reset to pending by automatic processing
    expect(row!.suggestedTitle).toBe("Human-approved title");
  });

  it("critical retry scenario: Web and eBay succeed, Etsy fails - the event fails; a retry regenerates only Etsy", async () => {
    const repo = createDrizzleMarketplacePreparationRepository(db as any);
    const failingProvider = providerThatFailsOneChannel(PublishChannel.Etsy);
    const handler = new AiSalesPreparationHandler(db as any, failingProvider);

    await expect(handler.handle(event())).rejects.toThrow();

    const web1 = await repo.findByProductIdAndChannel(productId, PublishChannel.NoctellaWeb);
    const ebay1 = await repo.findByProductIdAndChannel(productId, PublishChannel.Ebay);
    const etsy1 = await repo.findByProductIdAndChannel(productId, PublishChannel.Etsy);
    expect(web1).not.toBeNull();
    expect(ebay1).not.toBeNull();
    expect(etsy1).toBeNull(); // still absent after the failed first attempt

    // Second attempt: now Etsy succeeds too (provider no longer fails it).
    const secondHandler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    await secondHandler.handle(event());

    const web2 = await repo.findByProductIdAndChannel(productId, PublishChannel.NoctellaWeb);
    const etsy2 = await repo.findByProductIdAndChannel(productId, PublishChannel.Etsy);
    expect(web2!.providerName).toBe(web1!.providerName); // Web's already-succeeded row was never regenerated
    expect(etsy2).not.toBeNull(); // the previously-absent channel is now generated
  });

  it("best-effort price initialization does not fail the event even when the AI Intake proposal has no usable suggestedPriceEur", async () => {
    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    // event() payload omits intakeId entirely - tryInitializePriceFromAiIntake must no-op, not throw.
    await expect(handler.handle(event())).resolves.toBeUndefined();
    const product = await getProductById(db as any, productId);
    expect(product.priceEur).toBeNull();
  });

  it("best-effort price initialization never overwrites an existing non-null price", async () => {
    await updateProduct(db as any, productId, { priceEur: 500 });
    const intake = await createIntake(db as any, "admin-1");
    const generated = await generateIntakeProposal(db as any, intake.id, stubProvider({ suggestedPriceEur: 42 }));
    await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);

    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    await handler.handle(event({ payload: { productId, intakeId: intake.id } }));

    const product = await getProductById(db as any, productId);
    expect(product.priceEur).toBe(500); // the existing non-null price always wins
  });

  /**
   * Sprint 140 Formal Validation Required Fix 2: genuinely exercises the stale
   * expectedUpdatedAt / ProductVersionConflictError race - not merely "already non-null at first
   * read". All three channels are pre-seeded as already-"pending" so the channel loop's own
   * getProductById calls (inside generateMarketplacePreparation) are skipped entirely, isolating
   * this test to exactly the price-enrichment step's own getProductById/updateProduct calls.
   */
  it("a genuine Admin price race is exercised via ProductVersionConflictError: AI's stale write conflicts, Admin's value wins, no blind retry, Outbox event still succeeds", async () => {
    const prepRepo = createDrizzleMarketplacePreparationRepository(db as any);
    for (const channel of [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy]) {
      await prepRepo.upsert({
        id: `seed-${channel}`,
        productId,
        channel,
        baseProductUpdatedAt: new Date().toISOString(),
        suggestedTitle: null,
        suggestedDescription: null,
        suggestedConditionDescription: null,
        suggestedItemSpecifics: null,
        suggestedTags: null,
        suggestedMaterials: null,
        suggestedStyle: null,
        suggestedOccasion: null,
        suggestedShortDescription: null,
        suggestedSeoTitle: null,
        suggestedMetaDescription: null,
        suggestedFocusKeyword: null,
        providerName: "seed",
        promptVersion: "v1",
        generatedAt: new Date().toISOString(),
      });
    }

    const intake = await createIntake(db as any, "admin-1");
    const generated = await generateIntakeProposal(db as any, intake.id, stubProvider({ suggestedPriceEur: 42 }));
    await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);

    const initial = await getProductById(db as any, productId);
    expect(initial.priceEur).toBeNull(); // 1. Product starts with priceEur = null.

    const originalGetProductById = productsModule.getProductById;
    let raceInjected = false;
    // 2/3/4. Intercepts the price-enrichment step's own fresh read (guaranteed to be the FIRST read
    // of a still-null-priced Product, since the channel loop above never calls getProductById at
    // all thanks to the pre-seeded rows): captures the pre-Admin-write snapshot exactly as the AI
    // genuinely would (its own stale updatedAt), THEN applies the Admin's own canonical update -
    // AFTER AI has captured that stale updatedAt, but BEFORE AI's own write attempt - reproducing
    // the exact race window. The guard on raceInjected/priceEur===null makes this self-limiting: it
    // fires exactly once, never on the later "re-read once" call or the marketing-tags call.
    const getProductByIdSpy = vi.spyOn(productsModule, "getProductById").mockImplementation(async (dbArg: any, id: any) => {
      const snapshot = await originalGetProductById(dbArg, id);
      if (!raceInjected && snapshot.priceEur === null) {
        raceInjected = true;
        await productsModule.updateProduct(dbArg, id, { priceEur: 999, expectedUpdatedAt: snapshot.updatedAt });
      }
      return snapshot;
    });

    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    // 13. The AiSalesPreparationRequested processing is not failed merely because AI lost the pricing race.
    await expect(handler.handle(event({ payload: { productId, intakeId: intake.id } }))).resolves.toBeUndefined();

    expect(raceInjected).toBe(true); // the race genuinely fired against a still-null-priced read

    // 5/6/7/8/9/10/11. AI's write - built from the stale updatedAt it captured before the Admin's
    // update landed - genuinely conflicted (ProductVersionConflictError, uncaught by this test,
    // handled internally by tryInitializePriceFromAiIntake's own catch block: re-read once, stop,
    // never a blind retry-and-overwrite). Proven by the final state alone, exactly as the approved
    // architecture intends (no new field/flag exists to observe the conflict having occurred
    // directly - the outcome is the proof).
    getProductByIdSpy.mockRestore();
    const finalProduct = await getProductById(db as any, productId); // fresh, unmocked read
    expect(finalProduct.priceEur).toBe(999); // Admin's value wins - AI's suggested 42 was never applied

    // 12. Successful (pre-seeded) channel preparation work is preserved, untouched by the price race.
    for (const channel of [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy]) {
      expect(await prepRepo.findByProductIdAndChannel(productId, channel)).not.toBeNull();
    }
  });

  /**
   * Sprint 140 Formal Validation Required Fix 3: forces a genuine exception from inside the actual
   * price-enrichment attempt (not a missing-intakeId/invalid-proposal/already-non-null early
   * return) and proves it is swallowed only at the approved best-effort boundary - channel
   * preparation still completes, no fallback price is invented, and the Outbox event still
   * succeeds.
   */
  it("a genuine price-enrichment exception is best-effort and never fails an otherwise successful Outbox event", async () => {
    const intake = await createIntake(db as any, "admin-1");
    const generated = await generateIntakeProposal(db as any, intake.id, stubProvider({ suggestedPriceEur: 75 }));
    await updateProposalFieldReview(db as any, intake.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);

    // Forces the exact updateProduct call inside tryInitializePriceFromAiIntake's price-write
    // attempt to throw a genuine (non-ProductVersionConflictError) exception - the only path that
    // function's own try/catch re-throws rather than swallows, which the handler's own
    // .catch(()=>undefined) around tryInitializePriceFromAiIntake must then absorb.
    const updateProductSpy = vi.spyOn(productsModule, "updateProduct").mockRejectedValueOnce(new Error("Simulated price update failure"));

    const handler = new AiSalesPreparationHandler(db as any, new MockMarketplacePreparationProvider());
    await expect(handler.handle(event({ payload: { productId, intakeId: intake.id } }))).resolves.toBeUndefined(); // the Outbox event still succeeds

    expect(updateProductSpy).toHaveBeenCalled(); // the exception genuinely occurred inside the price-write attempt

    const product = await getProductById(db as any, productId);
    expect(product.priceEur).toBeNull(); // no fallback price invented; the mocked rejection prevented any real write

    const repo = createDrizzleMarketplacePreparationRepository(db as any);
    for (const channel of [PublishChannel.NoctellaWeb, PublishChannel.Ebay, PublishChannel.Etsy]) {
      expect(await repo.findByProductIdAndChannel(productId, channel)).not.toBeNull(); // channel preparation still completed
    }

    updateProductSpy.mockRestore();
  });
});
