import type { Category, Collection, Product, ProductImage } from "@noctella/shared";

/**
 * Input given to any AI listing provider. Deliberately provider-agnostic —
 * a real provider (OpenAI, Claude, etc.) would receive the same shape.
 */
export interface AiListingGenerationInput {
  product: Product;
  images: ProductImage[];
  category?: Category;
  collection?: Collection;
}

/** Structured result any AI listing provider must return. */
export interface AiListingGenerationResult {
  generatedTitle?: string;
  generatedDescription?: string;
  generatedStory?: string;
  generatedConditionDescription?: string;

  suggestedCategoryId?: string;
  suggestedCollectionId?: string;
  suggestedEurPrice?: number;
  suggestedUsdPrice?: number;
  suggestedMinimumOfferPrice?: number;

  seoTitle?: string;
  metaDescription?: string;
  keywords?: string[];

  shippingNote?: string;
  customsWarning?: boolean;

  aiConfidenceScore?: number;
  aiModel: string;
  generationPromptVersion: string;
}

/**
 * Contract for any AI listing draft provider. Sprint 3 ships only the
 * MockAiListingProvider below — no external/paid AI API is connected yet.
 * A future provider (OpenAI, Claude, etc.) implements this same interface.
 */
export interface AiListingProvider {
  generateListing(input: AiListingGenerationInput): Promise<AiListingGenerationResult>;
}
