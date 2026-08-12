import { PublishChannel } from "@noctella/shared";
import type { MarketplacePreparationProductContext, MarketplacePreparationPrompt, MarketplacePreparationPromptBuilder } from "./types";

/** Sprint 107: bump only when the prompt's content/shape actually changes. */
export const MARKETPLACE_PREPARATION_PROMPT_VERSION = "sprint110-v1";

function channelLabel(channel: PublishChannel): string {
  if (channel === PublishChannel.Ebay) return "eBay";
  if (channel === PublishChannel.Etsy) return "Etsy";
  return "Noctella Web (our own direct storefront)";
}

/**
 * Deterministic, pure, provider-independent: the same context always
 * produces byte-identical prompt fields. No I/O, no Date.now(), no
 * randomness. Never references AI Intake, staged photos, SKU, barcode,
 * stock, price authority, or any field outside the approved Sprint 107
 * scope.
 */
export class DeterministicMarketplacePreparationPromptBuilder implements MarketplacePreparationPromptBuilder {
  build(context: MarketplacePreparationProductContext): MarketplacePreparationPrompt {
    const systemPrompt =
      `You are adapting an existing, already-approved product listing's wording and SEO structure for ${channelLabel(context.channel)}. ` +
      "Use only the canonical product information provided below. The canonical fields below are operator-accepted context, not independently " +
      "verified facts - their presence does not by itself prove they are semantically correct. If a supplied maker, brand, manufacturer, or model " +
      "identity is clearly implausible (for example, a raw material or a generic word rather than a genuine identity), treat it as unknown and " +
      "omit it rather than confidently restating it. Never invent a maker, model, material, date, provenance, condition defect, " +
      "measurement, compatibility claim, or rarity claim that is not clearly evidenced by the provided text - leave a field null/unknown rather " +
      "than fabricate it. Adapt wording and structure only; do not change the underlying facts. " +
      "You are producing a draft proposal for human review only - you never publish anything, change stock, or set a marketplace price.";

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
      context.seoTitle ? `Existing SEO title: ${context.seoTitle}` : undefined,
      context.metaDescription ? `Existing meta description: ${context.metaDescription}` : undefined,
      context.priceEur != null ? `Current EUR price (context only, never a marketplace-price instruction): €${context.priceEur.toFixed(2)}` : undefined,
    ].filter((line): line is string => Boolean(line));

    return {
      version: MARKETPLACE_PREPARATION_PROMPT_VERSION,
      systemPrompt,
      userPrompt: userPromptLines.join("\n"),
    };
  }
}
