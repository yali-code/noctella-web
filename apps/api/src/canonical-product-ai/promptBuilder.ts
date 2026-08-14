import type { CanonicalProductProposalContext, CanonicalProductProposalPrompt, CanonicalProductProposalPromptBuilder } from "./types";

/** Sprint 148: bump only when the prompt's content/shape actually changes. */
export const CANONICAL_PRODUCT_PROPOSAL_PROMPT_VERSION = "sprint148-v1";

/**
 * Deterministic, pure, provider-independent: the same context always produces byte-identical
 * prompt fields. No I/O, no Date.now(), no randomness. Never references marketplace-channel
 * fields, AI Intake staged-photo state, SKU, barcode, stock, purchase cost, or any field outside
 * the approved Sprint 148 canonical scope (Product Details, Physical Information, Marketing
 * Tags).
 */
export class DeterministicCanonicalProductProposalPromptBuilder implements CanonicalProductProposalPromptBuilder {
  build(context: CanonicalProductProposalContext): CanonicalProductProposalPrompt {
    const systemPrompt =
      "You are proposing values for a physical antiques/collectibles product's canonical catalog record, for human review only - you never publish " +
      "anything, change stock, or set Product status. Use only the canonical product information and photos provided below. The canonical fields " +
      "below are operator-accepted context, not independently verified facts - if a supplied maker, brand, manufacturer, or model identity is " +
      "clearly implausible (for example, a raw material or a generic word rather than a genuine identity), treat it as unknown and omit it rather " +
      "than confidently restating it. Never invent or guess a maker, model, material, date, provenance, condition defect, compatibility claim, or " +
      "rarity claim that is not clearly evidenced - leave a field null/unknown rather than fabricate it.\n\n" +
      "Physical measurement rule (mandatory): you may propose a length, width, height, or weight value ONLY when the supplied photographs contain " +
      "explicit, reliable measurement evidence - a readable scale/ruler/measuring-tape/caliper display, or a dimension/weight printed on the " +
      "product, a label, or packaging. If you can only estimate size or weight from the product's general visual appearance, you MUST leave that " +
      "field null - never populate an exact physical measurement from appearance alone. Always convert whatever unit the evidence shows into " +
      "exactly cm or in for dimensions, and exactly kg or lb for weight (for example 85 mm becomes 8.5 cm; 350 g becomes 0.35 kg) - if the source " +
      "unit cannot be reliably determined, leave that field null rather than guess a unit.\n\n" +
      "Marketing Tag suggestions are short campaign/theme/segment labels (e.g. \"Father's Day\", \"Mid-Century Modern\") - never restate the " +
      "product's SEO keywords or an Etsy-style search tag list, and never repeat a tag already listed as an existing Marketing Tag below.";

    const userPromptLines = [
      `Product title: ${context.title}`,
      context.categoryName ? `Category: ${context.categoryName}` : undefined,
      context.brand ? `Brand: ${context.brand}` : undefined,
      context.model ? `Model: ${context.model}` : undefined,
      context.manufacturer ? `Manufacturer: ${context.manufacturer}` : undefined,
      context.countryOfOrigin ? `Country of origin: ${context.countryOfOrigin}` : undefined,
      context.period ? `Period: ${context.period}` : undefined,
      context.materials ? `Materials: ${context.materials}` : undefined,
      context.description ? `Existing description: ${context.description}` : "No product description is available.",
      context.productStory ? `Existing product story: ${context.productStory}` : undefined,
      context.condition ? `Condition: ${context.condition}` : undefined,
      context.conditionDescription ? `Condition description: ${context.conditionDescription}` : undefined,
      context.lengthValue != null && context.dimensionUnit ? `Existing length on file: ${context.lengthValue} ${context.dimensionUnit}` : undefined,
      context.widthValue != null && context.dimensionUnit ? `Existing width on file: ${context.widthValue} ${context.dimensionUnit}` : undefined,
      context.heightValue != null && context.dimensionUnit ? `Existing height on file: ${context.heightValue} ${context.dimensionUnit}` : undefined,
      context.weightValue != null && context.weightUnit ? `Existing weight on file: ${context.weightValue} ${context.weightUnit}` : undefined,
      context.existingMarketingTags && context.existingMarketingTags.length > 0
        ? `Existing Marketing Tags (never repeat these): ${context.existingMarketingTags.join(", ")}`
        : undefined,
      context.photos.length > 0
        ? `${context.photos.length} product photograph(s) are attached below, in order (the first is the product's primary photo).`
        : "No product photographs are available - propose Product Details/Marketing Tags from the text context only, and leave every physical measurement field null.",
    ].filter((line): line is string => Boolean(line));

    return {
      version: CANONICAL_PRODUCT_PROPOSAL_PROMPT_VERSION,
      systemPrompt,
      userPrompt: userPromptLines.join("\n"),
    };
  }
}
