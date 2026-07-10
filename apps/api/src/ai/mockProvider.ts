import type { AiListingGenerationInput, AiListingGenerationResult, AiListingProvider } from "./provider";

const MOCK_MODEL_NAME = "mock-local-v1";
const MOCK_PROMPT_VERSION = "sprint3-v1";

/**
 * Local, deterministic mock provider. Produces a plausible-looking draft
 * from existing product data with no network calls and no paid API.
 * Swappable later for a real provider (OpenAI, Claude, etc.) implementing
 * the same AiListingProvider interface.
 */
export class MockAiListingProvider implements AiListingProvider {
  async generateListing(input: AiListingGenerationInput): Promise<AiListingGenerationResult> {
    const { product, category, collection } = input;

    const title = product.title || "Untitled Item";
    const brandModel = [product.brand, product.model].filter(Boolean).join(" ");

    const generatedTitle = brandModel ? `${title} — ${brandModel}` : title;
    const generatedDescription = [
      product.description,
      category ? `Category: ${category.name}.` : undefined,
      product.materials ? `Materials: ${product.materials}.` : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    const generatedStory = product.productStory || `A distinctive piece from the Noctella collection.`;
    const generatedConditionDescription =
      product.conditionDescription || (product.condition ? `Condition: ${product.condition}.` : undefined);

    const suggestedEurPrice = product.priceEur;
    const suggestedUsdPrice = product.priceUsd;
    const suggestedMinimumOfferPrice = product.minOfferPrice;

    const keywords = [product.brand, product.model, category?.name, collection?.name]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase());

    return {
      generatedTitle,
      generatedDescription: generatedDescription || undefined,
      generatedStory,
      generatedConditionDescription,
      suggestedCategoryId: product.categoryId,
      suggestedCollectionId: product.collectionId,
      suggestedEurPrice,
      suggestedUsdPrice,
      suggestedMinimumOfferPrice,
      seoTitle: generatedTitle,
      metaDescription: generatedDescription ? generatedDescription.slice(0, 160) : undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
      shippingNote: product.shippingNote,
      customsWarning: product.customsWarning,
      aiConfidenceScore: 0.5,
      aiModel: MOCK_MODEL_NAME,
      generationPromptVersion: MOCK_PROMPT_VERSION,
    };
  }
}
