/**
 * Sprint 107: Marketplace Preparation generation contracts - fully
 * independent of ai-intake/* (photo-based, staged-AI-Intake-scoped) and
 * ai/* (channel-agnostic AiListingDraft). No import from either tree
 * anywhere in this module. Never depends on staged AI Intake state - the
 * only input is a fresh read of the current canonical Product, plus the
 * selected PublishChannel.
 */
import type { PublishChannel } from "@noctella/shared";

/**
 * Sprint 107: the read-only canonical-Product evidence a marketplace
 * preparation provider may use - deliberately text-only (no photo/image
 * access): every target field (eBay/Etsy/Noctella Web title, description,
 * condition description, item specifics, tags, materials, style, occasion,
 * SEO fields) is adaptable from canonical text fields already
 * reviewed/approved at Stock Acceptance - no vision input is required to
 * serve this Sprint's approved field scope, so none is requested (Economy
 * Mode: no new photo-storage/vision-access mechanism, no
 * AI_INTAKE_OPENAI_MAX_PHOTOS-style config needed). priceEur is included
 * only as read-only pricing *context* - the provider must never treat it as
 * marketplace-price authority, and no suggested price field exists anywhere
 * in MarketplacePreparationProposal below.
 */
export interface MarketplacePreparationProductContext {
  productId: string;
  channel: PublishChannel;
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
  seoTitle?: string;
  metaDescription?: string;
  /** Contextual only - never authoritative for any marketplace-specific price field. */
  priceEur: number;
}

export interface MarketplacePreparationPrompt {
  version: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface MarketplacePreparationPromptBuilder {
  build(context: MarketplacePreparationProductContext): MarketplacePreparationPrompt;
}

export interface MarketplacePreparationGenerationRequest {
  context: MarketplacePreparationProductContext;
  prompt: MarketplacePreparationPrompt;
}

/**
 * Sprint 107: the approved field scope only - see Sprint 107 Discovery
 * Report's field-ownership matrix. Deliberately excludes: any marketplace
 * listing price, ebayCategory (no safe constrained local source exists),
 * SKU/barcode/stock/status/collectionId, and every field the approved
 * architecture keeps outside AI authority. Every field is absent/undefined,
 * never a fabricated placeholder, whenever it cannot be reliably determined
 * from the supplied canonical Product context.
 */
export interface MarketplacePreparationProposal {
  suggestedTitle?: string;
  suggestedDescription?: string;
  suggestedConditionDescription?: string; // eBay
  suggestedItemSpecifics?: string; // eBay
  suggestedTags?: string[]; // Etsy
  suggestedMaterials?: string; // Etsy
  suggestedStyle?: string; // Etsy
  suggestedOccasion?: string; // Etsy
  suggestedShortDescription?: string; // Noctella Web
  suggestedSeoTitle?: string; // Noctella Web
  suggestedMetaDescription?: string; // Noctella Web
  suggestedFocusKeyword?: string; // Noctella Web
}

export interface MarketplacePreparationGenerationMetadata {
  providerName: string;
  promptVersion: string;
}

export interface MarketplacePreparationGenerationResult {
  proposal: MarketplacePreparationProposal;
  metadata: MarketplacePreparationGenerationMetadata;
}

export interface MarketplacePreparationProvider {
  generate(request: MarketplacePreparationGenerationRequest): Promise<MarketplacePreparationGenerationResult>;
}
