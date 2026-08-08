import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductStatus, ProductType, PublishChannel } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import { createTestDb } from "./testDb";
import {
  MarketplacePreparationGenerationInProgressError,
  MarketplacePreparationNotPendingError,
  MarketplacePreparationProviderInvalidResponseError,
  MarketplacePreparationVersionConflictError,
  ProductVersionConflictError,
} from "../src/services/errors";
import { buildMarketplacePreparationContext } from "../src/marketplace-prep/context";
import { MockMarketplacePreparationProvider } from "../src/marketplace-prep/mockProvider";
import { OpenAiMarketplacePreparationProvider } from "../src/marketplace-prep/openAiProvider";
import { createMarketplacePreparationProvider } from "../src/marketplace-prep/providerFactory";
import { DeterministicMarketplacePreparationPromptBuilder } from "../src/marketplace-prep/promptBuilder";
import type { MarketplacePreparationGenerationRequest } from "../src/marketplace-prep/types";
import {
  tryAcquireMarketplacePreparationGenerationGuard,
  releaseMarketplacePreparationGenerationGuard,
} from "../src/use-cases/marketplace-preparation/generationGuard";
import {
  approveMarketplacePreparationUseCase,
  generateMarketplacePreparationUseCase,
} from "../src/use-cases/marketplace-preparation/useCases";
import { createDrizzleMarketplacePreparationRepository } from "../src/repositories/marketplace-preparation/drizzle";
import { createMarketplacePreparationApprovalTransactionCapabilityForDb } from "../src/services/marketplacePreparationApprovalTransactionCapabilityForDb";
import { generateMarketplacePreparation, getCurrentMarketplacePreparation, approveMarketplacePreparation } from "../src/services/marketplacePreparation";
import { publishJobs, publishAttempts, externalListings, marketplacePreparations } from "../src/db/schema";

function stubProvider(proposal: Record<string, unknown> = {}) {
  return {
    generate: vi.fn(async (req: MarketplacePreparationGenerationRequest) => ({
      proposal: { suggestedTitle: "Stub Title", suggestedDescription: "Stub description.", ...proposal },
      metadata: { providerName: "stub-marketplace-prep", promptVersion: req.prompt.version },
    })),
  };
}

describe("Marketplace Preparation (Sprint 107)", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let productId: string;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true })).id;
    const product = await createProduct(db, {
      sku: `MP-${Math.random().toString(36).slice(2, 10)}`,
      title: "Moon Watch",
      description: "A rare vintage watch.",
      keywords: ["watch", "vintage"],
      brand: "Omega",
      materials: "Steel",
      condition: "Good",
      conditionDescription: "Minor wear on the bezel.",
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

  describe("MockMarketplacePreparationProvider", () => {
    it("is fully deterministic and channel-scoped for eBay - only populates eBay-relevant fields", async () => {
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      expect(context.brand).toBe("Omega"); // Sprint 110: a legitimate brand must reach the context unchanged.
      const provider = new MockMarketplacePreparationProvider();
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      const first = await provider.generate({ context, prompt });
      const second = await provider.generate({ context, prompt });
      expect(first).toEqual(second);
      expect(first.proposal.suggestedTitle).toBe("Moon Watch");
      expect(first.proposal.suggestedConditionDescription).toBe("Minor wear on the bezel.");
      expect(first.proposal.suggestedItemSpecifics).toContain("Omega");
      expect(first.proposal.suggestedTags).toBeUndefined();
      expect(first.proposal.suggestedSeoTitle).toBeUndefined();
    });

    it("Etsy: never fabricates style/occasion - no canonical Product field maps to them", async () => {
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Etsy);
      const provider = new MockMarketplacePreparationProvider();
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      const result = await provider.generate({ context, prompt });
      expect(result.proposal.suggestedStyle).toBeUndefined();
      expect(result.proposal.suggestedOccasion).toBeUndefined();
      expect(result.proposal.suggestedTags).toEqual(["watch", "vintage"]);
      expect(result.proposal.suggestedMaterials).toBe("Steel");
    });

    it("Noctella Web: never touches eBay/Etsy fields", async () => {
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.NoctellaWeb);
      const provider = new MockMarketplacePreparationProvider();
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      const result = await provider.generate({ context, prompt });
      expect(result.proposal.suggestedConditionDescription).toBeUndefined();
      expect(result.proposal.suggestedTags).toBeUndefined();
      expect(result.proposal.suggestedSeoTitle).toBeTruthy();
    });

    it("has no network/import dependency", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const src = await fs.readFile(path.resolve(__dirname, "../src/marketplace-prep/mockProvider.ts"), "utf8");
      expect(src).not.toMatch(/\bfetch\(|require\(["']https?["']\)|from ["']https?["']|axios/i);
    });
  });

  // Sprint 110: the observed Sprint 108 smoke regression - a clearly-generic, non-brand canonical
  // value (e.g. "Wood") must never reach a Marketplace Preparation provider as if it were a
  // trustworthy brand fact. Exercised entirely through the deterministic Mock provider - no live
  // OpenAI call is required, since the fix point (buildMarketplacePreparationContext) is upstream
  // of both providers equally.
  describe("brand factual-grounding guard (Sprint 110)", () => {
    async function createProductWithBrand(brand: string | undefined) {
      const unique = Math.random().toString(36).slice(2, 10);
      const product = await createProduct(db, {
        sku: `MP-${unique}`,
        title: `Carved Item ${unique}`, // unique per call - a shared title would collide on slug (Sprint 106/107 precedent)
        description: "An item with a questionable brand value.",
        brand,
        type: ProductType.UniqueItem,
        status: ProductStatus.Draft,
        categoryId,
        priceEur: 250,
        customsWarning: false,
        isFeatured: false,
        allowMakeOffer: false,
        allowCashOnDelivery: false,
        showInArchiveAfterSale: false,
      } as any);
      return getProductById(db, product.id);
    }

    it("a clearly-generic non-brand value ('Wood') is omitted from the context and never reaches eBay item specifics", async () => {
      const product = await createProductWithBrand("Wood");
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      expect(context.brand).toBeUndefined();

      const provider = new MockMarketplacePreparationProvider();
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      const result = await provider.generate({ context, prompt });
      expect(result.proposal.suggestedItemSpecifics ?? "").not.toContain("Brand: Wood");
    });

    it("case and surrounding whitespace do not defeat the guard", async () => {
      const paddedContext = buildMarketplacePreparationContext(await createProductWithBrand(" wood "), PublishChannel.Ebay);
      expect(paddedContext.brand).toBeUndefined();

      const upperContext = buildMarketplacePreparationContext(await createProductWithBrand("WOOD"), PublishChannel.Ebay);
      expect(upperContext.brand).toBeUndefined();
    });

    it("is exact-match only - a legitimate brand that merely contains a generic word is never filtered", async () => {
      const product = await createProductWithBrand("Woodward");
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      expect(context.brand).toBe("Woodward");

      const provider = new MockMarketplacePreparationProvider();
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      const result = await provider.generate({ context, prompt });
      expect(result.proposal.suggestedItemSpecifics).toContain("Brand: Woodward");
    });

    it("the shared prompt and the OpenAI addendum both state that supplied fields are context, not verified fact, without asserting the full prompt text", async () => {
      const product = await createProductWithBrand("Wood");
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      expect(prompt.systemPrompt).toContain("operator-accepted context, not independently");

      // Sprint 110 correction: verifies the OpenAI addendum's actual effect on the real outbound
      // request body (never source text) - mirrors this file's own OpenAiMarketplacePreparationProvider
      // request-body-inspection convention below. The minimal valid structured response is inlined
      // here rather than reaching into that later describe block's locally-scoped helpers.
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ suggestedTitle: "x", suggestedDescription: null, suggestedConditionDescription: null, suggestedItemSpecifics: null }),
                },
              ],
            },
          ],
        }),
      } as Response);
      const provider = new OpenAiMarketplacePreparationProvider({ apiKey: "sk-test", model: "gpt-test" });
      await provider.generate({ context, prompt });
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      // Sprint 110 Correction 2: "supplied fields are operator-accepted context" appears only in
      // OPENAI_SYSTEM_PROMPT_ADDENDUM ("The supplied fields are...") - the shared prompt instead
      // says "The canonical fields below are...". This substring is already proven true of
      // prompt.systemPrompt alone by the assertion above, so a shared substring here would pass
      // even if the addendum were dropped from the request; this addendum-only phrase does not.
      expect(body.instructions).toContain("supplied fields are operator-accepted context");
    });
  });

  describe("provider factory", () => {
    const ENV_KEYS = ["MARKETPLACE_PREP_PROVIDER", "AI_INTAKE_OPENAI_API_KEY", "AI_INTAKE_OPENAI_MODEL"] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    it("unset MARKETPLACE_PREP_PROVIDER selects the Mock provider", () => {
      expect(createMarketplacePreparationProvider()).toBeInstanceOf(MockMarketplacePreparationProvider);
    });

    it('MARKETPLACE_PREP_PROVIDER="openai" reuses AI_INTAKE_OPENAI_API_KEY/AI_INTAKE_OPENAI_MODEL, no new secret', () => {
      process.env.MARKETPLACE_PREP_PROVIDER = "openai";
      process.env.AI_INTAKE_OPENAI_API_KEY = "sk-test";
      process.env.AI_INTAKE_OPENAI_MODEL = "gpt-test";
      expect(createMarketplacePreparationProvider()).toBeInstanceOf(OpenAiMarketplacePreparationProvider);
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });

    it("openai without AI_INTAKE_OPENAI_API_KEY fails closed before any network call", () => {
      process.env.MARKETPLACE_PREP_PROVIDER = "openai";
      process.env.AI_INTAKE_OPENAI_MODEL = "gpt-test";
      const fetchSpy = vi.spyOn(global, "fetch");
      expect(() => createMarketplacePreparationProvider()).toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });
  });

  describe("OpenAiMarketplacePreparationProvider (structured output, no live network call)", () => {
    function rawResponse(body: unknown) {
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    function structuredResponse(payload: Record<string, unknown>) {
      return rawResponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }] });
    }

    it("maps a successful eBay structured response, never calling a real endpoint outside the mock", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        structuredResponse({ suggestedTitle: "Adapted Title", suggestedDescription: "Adapted description.", suggestedConditionDescription: null, suggestedItemSpecifics: null }),
      );
      const provider = new OpenAiMarketplacePreparationProvider({ apiKey: "sk-test", model: "gpt-test" });
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      const result = await provider.generate({ context, prompt });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
      expect(result.proposal.suggestedTitle).toBe("Adapted Title");
      expect(result.proposal.suggestedConditionDescription).toBeUndefined();
    });

    it("only requests the fields relevant to the selected channel in the JSON schema", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        structuredResponse({ suggestedTitle: "x", suggestedDescription: null, suggestedConditionDescription: null, suggestedItemSpecifics: null }),
      );
      const provider = new OpenAiMarketplacePreparationProvider({ apiKey: "sk-test", model: "gpt-test" });
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      await provider.generate({ context, prompt });
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(Object.keys(body.text.format.schema.properties).sort()).toEqual(
        ["suggestedConditionDescription", "suggestedDescription", "suggestedItemSpecifics", "suggestedTitle"].sort(),
      );
      expect(body.text.format.schema.properties.suggestedTags).toBeUndefined();
    });

    it("never sends image content - text-only input", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        structuredResponse({ suggestedTitle: "x", suggestedDescription: null, suggestedConditionDescription: null, suggestedItemSpecifics: null }),
      );
      const provider = new OpenAiMarketplacePreparationProvider({ apiKey: "sk-test", model: "gpt-test" });
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      await provider.generate({ context, prompt });
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.input[0].content.some((c: { type: string }) => c.type === "input_image")).toBe(false);
    });

    it("throws a typed invalid-response error for malformed structured output, without a live network call in tests", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(rawResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }));
      const provider = new OpenAiMarketplacePreparationProvider({ apiKey: "sk-test", model: "gpt-test" });
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      await expect(provider.generate({ context, prompt })).rejects.toBeInstanceOf(MarketplacePreparationProviderInvalidResponseError);
    });

    it("rejects a category-like invented field the schema never requested (strict, additionalProperties false)", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        structuredResponse({ suggestedTitle: "x", suggestedDescription: null, suggestedConditionDescription: null, suggestedItemSpecifics: null, suggestedTags: ["invented"] }),
      );
      const provider = new OpenAiMarketplacePreparationProvider({ apiKey: "sk-test", model: "gpt-test" });
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const prompt = new DeterministicMarketplacePreparationPromptBuilder().build(context);
      await expect(provider.generate({ context, prompt })).rejects.toBeInstanceOf(MarketplacePreparationProviderInvalidResponseError);
    });
  });

  describe("generation guard (paid-call duplicate safety)", () => {
    it("same product + same channel: a second concurrent claim is rejected", () => {
      expect(tryAcquireMarketplacePreparationGenerationGuard("p1", "ebay")).toBe(true);
      expect(tryAcquireMarketplacePreparationGenerationGuard("p1", "ebay")).toBe(false);
      releaseMarketplacePreparationGenerationGuard("p1", "ebay");
    });

    it("same product + different channel: independent, both succeed", () => {
      expect(tryAcquireMarketplacePreparationGenerationGuard("p1", "ebay")).toBe(true);
      expect(tryAcquireMarketplacePreparationGenerationGuard("p1", "etsy")).toBe(true);
      releaseMarketplacePreparationGenerationGuard("p1", "ebay");
      releaseMarketplacePreparationGenerationGuard("p1", "etsy");
    });

    it("release is idempotent and always frees the guard even after a provider failure", async () => {
      const repository = createDrizzleMarketplacePreparationRepository(db);
      const failingProvider = { generate: vi.fn(async () => { throw new Error("simulated provider failure"); }) };
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      await expect(
        generateMarketplacePreparationUseCase(repository, failingProvider as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context }),
      ).rejects.toThrow("simulated provider failure");
      // The guard was released - a second attempt is not blocked by MarketplacePreparationGenerationInProgressError.
      const secondProvider = stubProvider();
      await expect(
        generateMarketplacePreparationUseCase(repository, secondProvider as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context }),
      ).resolves.toBeTruthy();
    });

    it("concurrent same-product-and-channel generation: exactly one provider call proceeds", async () => {
      const repository = createDrizzleMarketplacePreparationRepository(db);
      const provider = stubProvider();
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const first = generateMarketplacePreparationUseCase(repository, provider as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context });
      await expect(
        generateMarketplacePreparationUseCase(repository, provider as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context }),
      ).rejects.toBeInstanceOf(MarketplacePreparationGenerationInProgressError);
      await first;
      expect(provider.generate).toHaveBeenCalledTimes(1);
    });
  });

  describe("generateMarketplacePreparationUseCase", () => {
    it("captures baseProductUpdatedAt from the fresh Product read, before the provider call", async () => {
      const repository = createDrizzleMarketplacePreparationRepository(db);
      const provider = stubProvider();
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      const row = await generateMarketplacePreparationUseCase(repository, provider as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context });
      expect(row.baseProductUpdatedAt).toBe(product.updatedAt);
      expect(row.status).toBe("pending");
    });

    it("regenerating refreshes the same row in place - always exactly one row per (productId, channel)", async () => {
      const repository = createDrizzleMarketplacePreparationRepository(db);
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, PublishChannel.Ebay);
      await generateMarketplacePreparationUseCase(repository, stubProvider({ suggestedTitle: "First" }) as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context });
      const second = await generateMarketplacePreparationUseCase(repository, stubProvider({ suggestedTitle: "Second" }) as any, { productId, channel: PublishChannel.Ebay, baseProductUpdatedAt: product.updatedAt, context });
      expect(second.suggestedTitle).toBe("Second");
      const rows = await db.select().from(marketplacePreparations);
      expect(rows).toHaveLength(1);
    });

    it("never reads AI Intake / staged photo state - no import statement anywhere in this domain reaches it", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      for (const file of ["marketplace-prep/types.ts", "marketplace-prep/context.ts", "marketplace-prep/mockProvider.ts", "marketplace-prep/openAiProvider.ts", "services/marketplacePreparation.ts"]) {
        const source = await fs.readFile(path.resolve(__dirname, "../src", file), "utf8");
        const importLines = source.split("\n").filter((line) => /^\s*import /.test(line)).join("\n");
        expect(importLines).not.toMatch(/ai-intake|AiProductIntake|ai_intake/i);
      }
    });
  });

  describe("approveMarketplacePreparationUseCase", () => {
    async function readyPreparation(channel: PublishChannel = PublishChannel.Ebay, proposal: Record<string, unknown> = {}) {
      const repository = createDrizzleMarketplacePreparationRepository(db);
      const product = await getProductById(db, productId);
      const context = buildMarketplacePreparationContext(product, channel);
      return generateMarketplacePreparationUseCase(repository, stubProvider(proposal) as any, { productId, channel, baseProductUpdatedAt: product.updatedAt, context });
    }
    function capability() {
      return createMarketplacePreparationApprovalTransactionCapabilityForDb(db as any, "sqlite");
    }

    it("Product unchanged since generation: approval succeeds, writes only the selected channel's fields", async () => {
      const proposal = await readyPreparation(PublishChannel.Ebay, { suggestedTitle: "eBay Title", suggestedDescription: "eBay Desc" });
      const result = await approveMarketplacePreparationUseCase(capability(), {
        id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
        title: "eBay Title", description: "eBay Desc",
      });
      expect(result.productId).toBe(productId);
      const product = await getProductById(db, productId);
      expect(product.ebayTitle).toBe("eBay Title");
      expect(product.ebayDescription).toBe("eBay Desc");
      expect(product.etsyTitle).toBeFalsy();
      expect(product.wooProductName).toBeFalsy();
    });

    it("Etsy approval does not modify eBay/Noctella Web fields", async () => {
      const proposal = await readyPreparation(PublishChannel.Etsy, { suggestedTitle: "Etsy Title", suggestedTags: ["a", "b"] });
      await approveMarketplacePreparationUseCase(capability(), {
        id: proposal.id as string, productId, channel: PublishChannel.Etsy, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
        title: "Etsy Title", tags: ["a", "b"],
      });
      const product = await getProductById(db, productId);
      expect(product.etsyTitle).toBe("Etsy Title");
      expect(product.etsyTags).toEqual(["a", "b"]);
      expect(product.ebayTitle).toBeFalsy();
      expect(product.wooProductName).toBeFalsy();
    });

    it("Noctella Web approval does not modify eBay/Etsy fields", async () => {
      const proposal = await readyPreparation(PublishChannel.NoctellaWeb, { suggestedTitle: "Woo Title" });
      await approveMarketplacePreparationUseCase(capability(), {
        id: proposal.id as string, productId, channel: PublishChannel.NoctellaWeb, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1",
        title: "Woo Title", seoTitle: "SEO Title",
      });
      const product = await getProductById(db, productId);
      expect(product.wooProductName).toBe("Woo Title");
      expect(product.wooSeoTitle).toBe("SEO Title");
      expect(product.ebayTitle).toBeFalsy();
      expect(product.etsyTitle).toBeFalsy();
    });

    it("Product edited after generation: approval fails with the existing ProductVersionConflict behavior", async () => {
      const proposal = await readyPreparation();
      await updateProduct(db, productId, { title: "Edited After Generation", expectedUpdatedAt: (await getProductById(db, productId)).updatedAt });
      await expect(
        approveMarketplacePreparationUseCase(capability(), {
          id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1", title: "x",
        }),
      ).rejects.toBeInstanceOf(ProductVersionConflictError);
    });

    it("a stale expectedProposalUpdatedAt (regenerated since loaded) is rejected", async () => {
      const proposal = await readyPreparation();
      await expect(
        approveMarketplacePreparationUseCase(capability(), {
          id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: "not-the-real-value", actorId: "admin-1", title: "x",
        }),
      ).rejects.toBeInstanceOf(MarketplacePreparationVersionConflictError);
    });

    it("approving an already-Applied preparation is rejected - requires a fresh regenerate", async () => {
      const proposal = await readyPreparation();
      await approveMarketplacePreparationUseCase(capability(), {
        id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1", title: "x",
      });
      await expect(
        approveMarketplacePreparationUseCase(capability(), {
          id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1", title: "y",
        }),
      ).rejects.toBeInstanceOf(MarketplacePreparationNotPendingError);
    });

    it("never changes SKU, stock quantity, Product status, or listing status", async () => {
      const before = await getProductById(db, productId);
      const proposal = await readyPreparation();
      await approveMarketplacePreparationUseCase(capability(), {
        id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1", title: "x",
      });
      const after = await getProductById(db, productId);
      expect(after.sku).toBe(before.sku);
      expect(after.stockQuantity).toBe(before.stockQuantity);
      expect(after.status).toBe(before.status);
      expect(after.ebayListingStatus ?? null).toBe(before.ebayListingStatus ?? null);
    });

    it("never creates a PublishJob, PublishAttempt, or ExternalListing, and never calls an outbound marketplace adapter", async () => {
      const fetchSpy = vi.spyOn(global, "fetch");
      const proposal = await readyPreparation();
      await approveMarketplacePreparationUseCase(capability(), {
        id: proposal.id as string, productId, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1", title: "x",
      });
      expect(await db.select().from(publishJobs)).toHaveLength(0);
      expect(await db.select().from(publishAttempts)).toHaveLength(0);
      expect(await db.select().from(externalListings)).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("atomic rollback: a forced failure during the Product update rolls back the whole approval - preparation stays Pending, Product unchanged", async () => {
      // A self-contained sqlite/db pair (not the shared beforeEach db) so a real CREATE TRIGGER can
      // force the Product UPDATE to fail - mirrors the established forced-failure test pattern used
      // throughout this codebase (e.g. aiIntakeStockAcceptance.test.ts's own forced-trigger tests).
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
        sku: `MP-ROLLBACK-${Math.random().toString(36).slice(2, 8)}`,
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

      const repository = createDrizzleMarketplacePreparationRepository(localDb);
      const context = buildMarketplacePreparationContext(localProduct, PublishChannel.Ebay);
      const proposal = await generateMarketplacePreparationUseCase(repository, stubProvider() as any, {
        productId: localProduct.id, channel: PublishChannel.Ebay, baseProductUpdatedAt: localProduct.updatedAt, context,
      });

      sqlite.exec("CREATE TRIGGER fail_marketplace_prep_product_update AFTER UPDATE OF ebay_title ON products BEGIN SELECT RAISE(ABORT,'forced failure'); END;");

      const localCapability = createMarketplacePreparationApprovalTransactionCapabilityForDb(localDb as any, "sqlite");
      await expect(
        approveMarketplacePreparationUseCase(localCapability, {
          id: proposal.id as string, productId: localProduct.id, channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt as string, actorId: "admin-1", title: "x",
        }),
      ).rejects.toThrow();

      const current = await getCurrentMarketplacePreparation(localDb, localProduct.id, PublishChannel.Ebay);
      expect(current.status).toBe("pending"); // the claim was rolled back together with the failed Product update
      const productAfter = await getProductById(localDb, localProduct.id);
      expect(productAfter.ebayTitle ?? null).toBeNull(); // the Product write never committed either

      sqlite.close();
    });
  });

  describe("service layer (generateMarketplacePreparation / getCurrentMarketplacePreparation / approveMarketplacePreparation)", () => {
    it("generateMarketplacePreparation reads the canonical Product fresh via getProductById", async () => {
      const spy = vi.spyOn(await import("../src/services/products"), "getProductById");
      await generateMarketplacePreparation(db, productId, PublishChannel.Ebay, new MockMarketplacePreparationProvider());
      expect(spy).toHaveBeenCalledWith(db, productId);
      spy.mockRestore();
    });

    it("getCurrentMarketplacePreparation returns 404-style NotFoundError when nothing was generated yet", async () => {
      const { NotFoundError } = await import("../src/services/errors");
      await expect(getCurrentMarketplacePreparation(db, productId, PublishChannel.Ebay)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("approveMarketplacePreparation returns the current canonical Product with the approved channel fields set", async () => {
      await generateMarketplacePreparation(db, productId, PublishChannel.Ebay, new MockMarketplacePreparationProvider());
      const proposal = await getCurrentMarketplacePreparation(db, productId, PublishChannel.Ebay);
      const product = await approveMarketplacePreparation(
        db,
        productId,
        { channel: PublishChannel.Ebay, expectedProposalUpdatedAt: proposal.updatedAt, title: "Moon Watch", description: "A rare vintage watch." },
        "admin-1",
      );
      expect(product.ebayTitle).toBe("Moon Watch");
    });
  });

  describe("regression: existing publish pipeline untouched by this domain", () => {
    it("services/publishing.ts, marketplacePublishing.ts, marketplaceAdapters.ts have zero references to marketplace-prep/*", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      for (const file of ["services/publishing.ts", "services/marketplacePublishing.ts", "services/marketplaceAdapters.ts"]) {
        const source = await fs.readFile(path.resolve(__dirname, "../src", file), "utf8");
        expect(source).not.toMatch(/marketplace-prep|marketplacePreparation|MarketplacePreparation/);
      }
    });
  });

  describe("database foundation (SQLite/Postgres schema and migration parity)", () => {
    it("SQLite ensureSchema is idempotent for the new marketplace_preparations table", async () => {
      const Database = (await import("better-sqlite3")).default;
      const { ensureSchema } = await import("../src/db/migrate");
      const freshSqlite = new Database(":memory:");
      freshSqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      const tables = (freshSqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      expect(tables).toContain("marketplace_preparations");
      const columns = (freshSqlite.prepare("PRAGMA table_info(marketplace_preparations)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "id", "product_id", "channel", "status", "base_product_updated_at",
          "suggested_title", "suggested_description", "suggested_condition_description", "suggested_item_specifics",
          "suggested_tags", "suggested_materials", "suggested_style", "suggested_occasion",
          "suggested_short_description", "suggested_seo_title", "suggested_meta_description", "suggested_focus_keyword",
          "provider_name", "prompt_version", "generated_at", "applied_at", "applied_by_admin_user_id",
        ]),
      );
      freshSqlite.close();
    });

    it("the (product_id, channel) unique index enforces at most one row per pair, even via a raw insert", async () => {
      const Database = (await import("better-sqlite3")).default;
      const { ensureSchema } = await import("../src/db/migrate");
      const freshSqlite = new Database(":memory:");
      freshSqlite.pragma("foreign_keys = ON");
      ensureSchema(freshSqlite);
      const now = new Date().toISOString();
      freshSqlite
        .prepare(
          "INSERT INTO marketplace_preparations (id, product_id, channel, base_product_updated_at, provider_name, prompt_version, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("mp-1", "product-x", "ebay", now, "mock", "v1", now);
      expect(() =>
        freshSqlite
          .prepare(
            "INSERT INTO marketplace_preparations (id, product_id, channel, base_product_updated_at, provider_name, prompt_version, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("mp-2", "product-x", "ebay", now, "mock", "v1", now),
      ).toThrow(/UNIQUE constraint failed/);
      freshSqlite.close();
    });

    it("PostgreSQL migration 0014 adds the marketplace_preparations table additively, without dropping anything", async () => {
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const { validatePostgresMigrationSql } = await import("../src/services/databaseMigrationFoundation");
      const root = path.resolve(__dirname, "..");
      const migrationSql = readFileSync(path.join(root, "src/db/postgres-migrations/0014_sprint107_marketplace_preparation.sql"), "utf8");
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS marketplace_preparations");
      expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_preparations_product_channel");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE/i);
      const validation = validatePostgresMigrationSql();
      expect(validation.status).toBe("PASS");
      expect(validation.hasDrop).toBe(false);
    });

    it("database parity remains PASS", async () => {
      const { runSchemaParity } = await import("../src/services/databaseMigrationFoundation");
      const parity = runSchemaParity();
      expect(parity.status).toBe("PASS");
    });

    it("does not modify or repurpose ai_listing_drafts, ai_intake_proposals, publish_jobs, publish_attempts, or external_listings - no DDL statement targets any of them", async () => {
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const root = path.resolve(__dirname, "..");
      const migrationSql = readFileSync(path.join(root, "src/db/postgres-migrations/0014_sprint107_marketplace_preparation.sql"), "utf8");
      const ddlLines = migrationSql.split("\n").filter((line) => !line.trim().startsWith("--"));
      const ddl = ddlLines.join("\n");
      for (const table of ["ai_listing_drafts", "ai_intake_proposals", "publish_jobs", "publish_attempts", "external_listings"]) {
        expect(ddl).not.toContain(table);
      }
    });
  });
});
