/**
 * Sprint 140: Product-level AI Sales Enrichment contracts - a small, domain-scoped module,
 * independent of marketplace-prep/* (per-channel listing copy) and ai-intake/* (photo-based
 * warehouse identification). Produces exactly one thing: an initial Marketing Tag suggestion set
 * for a Product. Deliberately does NOT produce a price - the canonical initial price source is
 * the existing AI Intake proposal's suggestedPriceEur (see services/aiSalesPreparationOutbox.ts),
 * not a new provider call, per Architecture Review.
 */

/**
 * Sprint 140: the read-only canonical-Product evidence a Sales Enrichment provider may use -
 * text-only, mirrors marketplace-prep/types.ts's MarketplacePreparationProductContext shape for
 * the fields it shares, but has no channel dimension (this is a single Product-level call, never
 * per-channel) and no priceEur field at all (this provider is never asked for price).
 */
export interface SalesEnrichmentProductContext {
  productId: string;
  title: string;
  description?: string;
  keywords?: string[];
  brand?: string;
  model?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  period?: string;
  materials?: string;
  condition?: string;
  conditionDescription?: string;
}

export interface SalesEnrichmentPrompt {
  version: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface SalesEnrichmentPromptBuilder {
  build(context: SalesEnrichmentProductContext): SalesEnrichmentPrompt;
}

export interface SalesEnrichmentGenerationRequest {
  context: SalesEnrichmentProductContext;
  prompt: SalesEnrichmentPrompt;
}

/**
 * Sprint 140: the approved output scope only - commercial/gifting Marketing Tag suggestions
 * (raw, uncanonicalized labels; canonicalization/dedup/empty-key rejection happens in
 * services/marketingTags.ts, never inside the provider). An empty array is a valid, expected
 * result whenever the provider has no confident suggestion - never a fabricated default.
 */
export interface SalesEnrichmentResult {
  marketingTags: string[];
}

export interface SalesEnrichmentGenerationMetadata {
  providerName: string;
  promptVersion: string;
}

export interface SalesEnrichmentGenerationResult {
  result: SalesEnrichmentResult;
  metadata: SalesEnrichmentGenerationMetadata;
}

export interface SalesEnrichmentProvider {
  generate(request: SalesEnrichmentGenerationRequest): Promise<SalesEnrichmentGenerationResult>;
}
