import type {
  SalesEnrichmentGenerationRequest,
  SalesEnrichmentGenerationResult,
  SalesEnrichmentProvider,
} from "./types";

const MOCK_SALES_ENRICHMENT_PROVIDER_NAME = "mock-sales-enrichment-v1";

/**
 * Sprint 140: fully local, deterministic mock. No network call, no fetch, no SDK dependency, no
 * paid API. Identical input always produces an identical result. Independent of
 * marketplace-prep/mockProvider.ts and ai-intake/mockProvider.ts - no import, no shared logic.
 *
 * Only ever derives suggestions from category-like signals already present in the canonical
 * context (condition, materials, keywords) - never fabricates a gifting occasion that has no
 * supporting evidence. Deliberately conservative: an empty result is a normal, valid mock output,
 * matching how a real provider would behave for a Product with no obvious commercial-intent
 * signal.
 */
export class MockSalesEnrichmentProvider implements SalesEnrichmentProvider {
  async generate(request: SalesEnrichmentGenerationRequest): Promise<SalesEnrichmentGenerationResult> {
    const { context } = request;
    const tags: string[] = [];

    if (context.condition && /vintage|antique/i.test(context.condition)) tags.push("vintage-gift");
    if (context.keywords?.some((k) => /watch/i.test(k)) || /watch/i.test(context.title)) tags.push("watch-collector");
    if (context.keywords?.some((k) => /camera/i.test(k)) || /camera/i.test(context.title)) tags.push("collectors-gift");

    return {
      result: { marketingTags: tags },
      metadata: {
        providerName: MOCK_SALES_ENRICHMENT_PROVIDER_NAME,
        promptVersion: request.prompt.version,
      },
    };
  }
}
