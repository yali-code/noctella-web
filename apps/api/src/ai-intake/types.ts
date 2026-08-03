/**
 * Sprint 92: AI Intake generation contracts. Fully independent of
 * apps/api/src/ai/provider.ts, apps/api/src/ai/mockProvider.ts, and the
 * ai_listing_drafts domain - no imports from any of them anywhere in this
 * module tree. No persistence is defined here; every value in this file is
 * either an in-memory contract or a pure-function input/output shape.
 */

/**
 * Provider-facing photo reference. `referenceId` is the canonical
 * AiIntakePhoto id (Sprint 92 exact-review correction) - a true opaque
 * identifier, never the Sprint 91 storage key and never equal to it. Only
 * AiIntakePhotoReader (via AiIntakePhotoStorageKeyResolver) is allowed to
 * resolve it to a storage key. No filesystem path, storage root, or
 * function is ever a field on this type.
 */
export interface AiIntakePhotoReference {
  id: string;
  originalFilename: string;
  referenceId: string;
}

/**
 * Separate capability interface for resolving a reference to real bytes.
 * Kept apart from AiIntakePhotoReference itself so the reference stays a
 * plain, structurally-comparable value object - see ai-intake/photoReader.ts.
 */
export interface AiIntakePhotoReader {
  read(referenceId: string): Promise<Buffer>;
}

/**
 * Sprint 92 exact-review correction: the small resolver boundary between
 * AiIntakePhotoReader and the photo domain. Deliberately DB-free at the
 * type level (this interface has no database dependency) - a concrete
 * implementation backed by the existing canonical AiIntakePhotoRepository
 * lives in services/aiIntakePhotoStorageKeyResolver.ts, outside this
 * independent module tree. Returns null (not a thrown error) when the id
 * cannot be resolved, so the reader decides how to fail.
 */
export interface AiIntakePhotoStorageKeyResolver {
  resolve(photoId: string): Promise<string | null>;
}

/**
 * Minimal generation context - only values that already exist on
 * AiProductIntake/AiIntakePhoto. No marketplace, language, model,
 * temperature, actor, Product, Inventory, publishing state, or intake
 * status - none of these have an approved source or a current need.
 */
export interface AiIntakeGenerationContext {
  intakeId: string;
  photos: AiIntakePhotoReference[];
}

export interface AiIntakePrompt {
  version: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface AiIntakePromptBuilder {
  build(context: AiIntakeGenerationContext): AiIntakePrompt;
}

export interface AiIntakeGenerationRequest {
  context: AiIntakeGenerationContext;
  prompt: AiIntakePrompt;
  photoReader: AiIntakePhotoReader;
}

/**
 * Minimal, typed, proposal-oriented result. No category, collection, price,
 * SKU, marketplace field, SEO field, Product status, or publishing
 * readiness - none of these are grounded in anything AiIntakeGenerationContext
 * actually contains (no Product exists yet to react to).
 */
export interface AiIntakeProposal {
  suggestedTitle?: string;
  suggestedDescription?: string;
  suggestedKeywords?: string[];
  confidenceScore?: number;
}

export interface AiIntakeGenerationMetadata {
  providerName: string;
  promptVersion: string;
}

export interface AiIntakeGenerationResult {
  proposal: AiIntakeProposal;
  metadata: AiIntakeGenerationMetadata;
}

export interface AiIntakeGenerationProvider {
  generate(request: AiIntakeGenerationRequest): Promise<AiIntakeGenerationResult>;
}
