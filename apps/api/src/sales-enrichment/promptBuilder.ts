import type { SalesEnrichmentPrompt, SalesEnrichmentPromptBuilder, SalesEnrichmentProductContext } from "./types";

/** Sprint 140: bump only when the prompt's content/shape actually changes. */
export const SALES_ENRICHMENT_PROMPT_VERSION = "sprint140-v1";

/**
 * Deterministic, pure, provider-independent: the same context always produces byte-identical
 * prompt fields. No I/O, no Date.now(), no randomness. Asks only for commercial/gifting Marketing
 * Tags - never a price, never a marketplace-specific field, never Product identity/inventory.
 */
export class DeterministicSalesEnrichmentPromptBuilder implements SalesEnrichmentPromptBuilder {
  build(context: SalesEnrichmentProductContext): SalesEnrichmentPrompt {
    const systemPrompt =
      "You are suggesting commercial and gifting Marketing Tags for an already-approved product, based only on the canonical product " +
      "information provided below. Marketing Tags describe WHEN, WHY, or TO WHOM the product could sell (for example: fathers-day, christmas, " +
      "gift-for-him, watch-collector) - they are never a product category, a marketplace listing tag, or an SEO keyword. Suggest a short list of " +
      "relevant tags only when genuinely supported by the product information; return an empty list rather than inventing a tag that isn't " +
      "reasonably evidenced. Never suggest a price. Never invent facts not present below. " +
      "You are producing a draft suggestion for human review only - you never publish anything, change stock, or set Product identity.";

    const userPromptLines = [
      `Product title: ${context.title}`,
      context.description ? `Product description: ${context.description}` : "No product description is available.",
      context.keywords && context.keywords.length > 0 ? `Keywords: ${context.keywords.join(", ")}` : undefined,
      context.brand ? `Brand: ${context.brand}` : undefined,
      context.model ? `Model: ${context.model}` : undefined,
      context.manufacturer ? `Manufacturer: ${context.manufacturer}` : undefined,
      context.countryOfOrigin ? `Country of origin: ${context.countryOfOrigin}` : undefined,
      context.period ? `Period: ${context.period}` : undefined,
      context.materials ? `Materials: ${context.materials}` : undefined,
      context.condition ? `Condition: ${context.condition}` : undefined,
      context.conditionDescription ? `Condition description: ${context.conditionDescription}` : undefined,
    ].filter((line): line is string => Boolean(line));

    return {
      version: SALES_ENRICHMENT_PROMPT_VERSION,
      systemPrompt,
      userPrompt: userPromptLines.join("\n"),
    };
  }
}
