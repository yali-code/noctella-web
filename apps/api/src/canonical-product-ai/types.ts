/**
 * Sprint 148: canonical Product AI proposal generation contracts. Fully independent of
 * marketplace-prep/* (channel-scoped, text-only) and ai-intake/* (pre-Product, staged-photo-
 * scoped) - no import from either tree anywhere in this module. The only input is a fresh read of
 * the current canonical Product, its existing Marketing Tags (context only), and its ordered
 * canonical ProductPhoto set (ai-intake's proven image-transport technique is reused, but this is
 * a dedicated, isolated provider/context path - marketplace-prep's providers are never turned
 * into vision providers, per Architecture Review item F).
 */

/** Provider-facing photo reference - id + already-public url; the reader resolves bytes from the existing canonical photo storage root, never a new storage mechanism. */
export interface CanonicalProductPhotoReference {
  id: string;
  url: string;
}

/** Mirrors ai-intake/types.ts's AiIntakePhotoReader contract exactly, scoped to canonical ProductPhoto storage instead of staged intake photos. */
export interface CanonicalProductPhotoReader {
  read(photo: CanonicalProductPhotoReference): Promise<Buffer>;
}

export interface CanonicalProductProposalContext {
  productId: string;
  title: string;
  categoryName?: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  period?: string;
  materials?: string;
  description?: string;
  productStory?: string;
  condition?: string;
  conditionDescription?: string;
  lengthValue?: number;
  widthValue?: number;
  heightValue?: number;
  dimensionUnit?: string;
  weightValue?: number;
  weightUnit?: string;
  /** Read-only context, never a source the Accept flow trusts blindly - existing tags the model should avoid duplicating. */
  existingMarketingTags?: string[];
  /**
   * Already capped to the configured maximum and ordered primary-first, then sortOrder, then a
   * stable id tie-break (see context.ts) - the provider must never re-order or re-truncate this
   * list itself.
   */
  photos: CanonicalProductPhotoReference[];
}

export interface CanonicalProductProposalPrompt {
  version: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface CanonicalProductProposalPromptBuilder {
  build(context: CanonicalProductProposalContext): CanonicalProductProposalPrompt;
}

export interface CanonicalProductProposalGenerationRequest {
  context: CanonicalProductProposalContext;
  prompt: CanonicalProductProposalPrompt;
  photoReader: CanonicalProductPhotoReader;
}

/**
 * Sprint 148: the approved field scope only (Architecture Review items C/D/L). Physical fields
 * are present ONLY when explicit visible measurement evidence supported them (item E) - every
 * field is absent/undefined, never a fabricated placeholder or a rough visual estimate, whenever
 * it cannot be reliably determined. dimensionUnit/weightUnit are always one of the existing
 * canonical enum values (cm|in, kg|lb) or absent - never a new unit taxonomy (item F).
 */
export interface CanonicalProductProposal {
  suggestedBrand?: string;
  suggestedModel?: string;
  suggestedManufacturer?: string;
  suggestedCountryOfOrigin?: string;
  suggestedPeriod?: string;
  suggestedMaterials?: string;
  suggestedDescription?: string;
  suggestedProductStory?: string;
  suggestedCondition?: string;
  suggestedConditionDescription?: string;
  suggestedLengthValue?: number;
  suggestedWidthValue?: number;
  suggestedHeightValue?: number;
  suggestedDimensionUnit?: string;
  suggestedWeightValue?: number;
  suggestedWeightUnit?: string;
  suggestedMarketingTags?: string[];
}

export interface CanonicalProductProposalGenerationMetadata {
  providerName: string;
  promptVersion: string;
  /** How many of context.photos were actually read successfully and sent to the model - 0 means Physical Information must be omitted regardless of what the provider itself returned (defense in depth, see useCases.ts's sanitizeGenerationResult). */
  imagesUsedCount: number;
}

export interface CanonicalProductProposalGenerationResult {
  proposal: CanonicalProductProposal;
  metadata: CanonicalProductProposalGenerationMetadata;
}

export interface CanonicalProductProposalProvider {
  generate(request: CanonicalProductProposalGenerationRequest): Promise<CanonicalProductProposalGenerationResult>;
}
