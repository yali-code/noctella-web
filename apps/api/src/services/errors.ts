export class NotFoundError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Sprint 88 (ADR-017): thrown when a Product update's expectedUpdatedAt no
 * longer matches the current row. Extends ConflictError so any existing
 * generic `instanceof ConflictError` handling (e.g. ERP command sanitization)
 * still recognizes it, while routes/errorHandler.ts checks this specific
 * subclass first to attach the structured PRODUCT_VERSION_CONFLICT fields.
 */
export class ProductVersionConflictError extends ConflictError {
  readonly productId: string;
  readonly expectedUpdatedAt: string;
  readonly currentUpdatedAt: string | null;

  constructor(productId: string, expectedUpdatedAt: string, currentUpdatedAt: string | null) {
    super("This product changed after you opened it. Reload the latest version before saving again.");
    this.name = "ProductVersionConflictError";
    this.productId = productId;
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.currentUpdatedAt = currentUpdatedAt;
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/**
 * Sprint 89: thrown when approval is attempted on an AI Draft with no
 * baseProductUpdatedAt (a legacy row generated before that field existed).
 * There is no trustworthy baseline to compare the Product against, so
 * approval is blocked before any transaction opens - never silently
 * substituted with the Product's current updatedAt.
 */
export class AiDraftRegenerationRequiredError extends ConflictError {
  constructor() {
    super("This draft must be regenerated before it can be approved.");
    this.name = "AiDraftRegenerationRequiredError";
  }
}

/**
 * Sprint 89: thrown when an AI Draft's atomic PendingReview claim affects
 * zero rows because another request already reviewed it first (a concurrent
 * approval loss, distinct from the existing sequential "already terminal"
 * BadRequestError raised by a pre-transaction status check).
 */
export class AiDraftReviewConflictError extends ConflictError {
  constructor() {
    super("This draft has already been reviewed.");
    this.name = "AiDraftReviewConflictError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Sprint 93: thrown when an AI Intake proposal write's baseline (either "no
 * proposal exists yet" for first generation, or "proposal id + updatedAt"
 * for regeneration/field-review) no longer matches the current row at write
 * time - a lost race, never resolved via last-write-wins.
 */
export class AiIntakeProposalVersionConflictError extends ConflictError {
  constructor(message = "This proposal changed before the operation completed. Reload it and try again.") {
    super(message);
    this.name = "AiIntakeProposalVersionConflictError";
  }
}

/**
 * Sprint 93: thrown when POST /generate is called while any field decision
 * is not Pending - regeneration is only allowed once every field has been
 * explicitly reset to Pending, so a single generation's suggestions and
 * metadata are never mixed with a prior generation's reviewed values.
 */
export class AiIntakeProposalReviewResetRequiredError extends ConflictError {
  constructor() {
    super("Reset all reviewed fields to pending before regenerating the proposal.");
    this.name = "AiIntakeProposalReviewResetRequiredError";
  }
}

/**
 * Sprint 93: thrown when a field-review write is attempted against a
 * proposal whose stored photo_set_fingerprint no longer matches the
 * intake's current staged photos.
 */
export class AiIntakeProposalStaleError extends ConflictError {
  constructor(message = "The staged photos changed after this proposal was generated. Regenerate the proposal before reviewing fields.") {
    super(message);
    this.name = "AiIntakeProposalStaleError";
  }
}

/**
 * Sprint 93: thrown when an atomic proposal write's intake-status EXISTS
 * guard fails - the intake was cancelled after the service-layer pre-check
 * passed but before the write completed (a race, not a simple bad-request).
 */
export class AiIntakeProposalIntakeNotOpenError extends ConflictError {
  constructor() {
    super("This intake is no longer Open. Generation and review are not available for a cancelled intake.");
    this.name = "AiIntakeProposalIntakeNotOpenError";
  }
}

/**
 * Sprint 93 correction pass: thrown when a field-review request submits
 * decision=Accepted for a field whose current AI suggestion is absent,
 * empty, or (for keywords) reduces to zero entries after normalization -
 * Accepted must always have an explicit, non-null stored value, never a
 * silently-substituted Rejected/Pending decision.
 */
export class AiIntakeProposalSuggestionUnavailableError extends BadRequestError {
  constructor() {
    super("The selected field has no valid AI suggestion to accept.");
    this.name = "AiIntakeProposalSuggestionUnavailableError";
  }
}

/**
 * Sprint 94: thrown when Save as Draft is attempted against an intake that
 * is not Open and not already Applied (i.e. Cancelled) - the atomic apply
 * write's own guard rejected it, not just a service-layer pre-check.
 */
export class AiIntakeApplyIntakeNotOpenError extends ConflictError {
  constructor() {
    super("This intake is no longer Open. Save as Draft is not available for a cancelled intake.");
    this.name = "AiIntakeApplyIntakeNotOpenError";
  }
}

/**
 * Sprint 94: thrown when the client's expectedProposalUpdatedAt no longer
 * matches the current proposal row read inside the locked apply transaction
 * - the proposal was reviewed or regenerated after the client last loaded it.
 */
export class AiIntakeApplyProposalVersionConflictError extends ConflictError {
  constructor() {
    super("This proposal changed before Save as Draft completed. Reload it and try again.");
    this.name = "AiIntakeApplyProposalVersionConflictError";
  }
}

/**
 * Sprint 94: thrown when the durable proposal's title is not Accepted/Edited
 * with a valid non-empty value (Pending/Rejected title blocks apply), or an
 * Accepted/Edited optional field (description/keywords) has no valid stored
 * value despite its decision claiming otherwise.
 */
export class AiIntakeApplyProposalNotReadyError extends ConflictError {
  constructor(message = "The proposal is not ready to be saved as a draft - the title must be Accepted or Edited with a valid value.") {
    super(message);
    this.name = "AiIntakeApplyProposalNotReadyError";
  }
}

/**
 * Sprint 94: thrown when the staged photo set (read inside the locked apply
 * transaction) no longer matches the proposal's stored photoSetFingerprint.
 */
export class AiIntakeApplyPhotoSetStaleError extends ConflictError {
  constructor() {
    super("The staged photos changed after this proposal was generated. Regenerate the proposal before saving as a draft.");
    this.name = "AiIntakeApplyPhotoSetStaleError";
  }
}

/**
 * Sprint 94: thrown for an unrecoverable, defensive intake result-state
 * conflict - status is Applied but resultProductId is null, or
 * resultProductId is set but references no findable Product, or the
 * apply write's own atomic guard failed despite the lock already being held.
 * Never repaired by creating a second Product.
 */
export class AiIntakeApplyResultStateInvalidError extends ConflictError {
  constructor(message = "This intake's applied result is in an unexpected state and cannot be resolved automatically.") {
    super(message);
    this.name = "AiIntakeApplyResultStateInvalidError";
  }
}

/**
 * Sprint 95: thrown when a staged AI intake photo delete is attempted
 * against an intake whose current status (verified inside the intake-row
 * lock, not just a service-layer pre-check) does not permit deletion - Open
 * and Cancelled remain deletable (preserving Sprint 91/93 behavior); Applied,
 * Finalized, and any future unrecognized status are rejected (fail closed).
 */
export class AiIntakePhotoMutationNotAllowedError extends ConflictError {
  constructor(message = "Staged photos cannot be deleted once the intake has reached this status.") {
    super(message);
    this.name = "AiIntakePhotoDeletionNotAllowedError";
  }
}

/**
 * Sprint 95: thrown when POST /:id/finalize-photos is attempted against an
 * intake that is not Applied and not already Finalized (i.e. Open or
 * Cancelled) - the atomic finalization write's own guard rejected it, not
 * just a service-layer pre-check.
 */
export class AiIntakePhotoFinalizationNotAppliedError extends ConflictError {
  constructor(message = "This intake must be Applied before its photos can be finalized.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationNotAppliedError";
  }
}

/**
 * Sprint 95: thrown for an unrecoverable, defensive finalization result-state
 * conflict - the intake is Applied but resultProductId is null, the
 * referenced Product cannot be found, or an already-Finalized intake's
 * recorded state (Product, ProductPhoto rows, Primary, audit fields) is
 * internally inconsistent. Never repaired automatically.
 */
export class AiIntakePhotoFinalizationResultStateInvalidError extends ConflictError {
  constructor(message = "This intake's finalization result is in an unexpected state and cannot be resolved automatically.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationResultStateInvalidError";
  }
}

/** Sprint 95: thrown when the referenced Product is not in Draft status on a first finalization attempt. */
export class AiIntakePhotoFinalizationProductNotDraftError extends ConflictError {
  constructor(message = "The Product must remain in Draft status before its photos can be finalized.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationProductNotDraftError";
  }
}

/** Sprint 95: thrown when the Product already has one or more canonical ProductPhoto rows - human-created photos are never appended to, replaced, or overridden. */
export class AiIntakePhotoFinalizationProductPhotosExistError extends ConflictError {
  constructor(message = "This Product already has canonical photos. Finalization only applies to a Product with no existing photos.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationProductPhotosExistError";
  }
}

/** Sprint 95: thrown when the intake has no staged photos to finalize. */
export class AiIntakePhotoFinalizationNoStagedPhotosError extends ConflictError {
  constructor(message = "This intake has no staged photos to finalize.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationNoStagedPhotosError";
  }
}

/** Sprint 95: thrown when a client-supplied primaryIntakePhotoId does not belong to the intake's current staged photo set. */
export class AiIntakePhotoFinalizationPrimaryInvalidError extends BadRequestError {
  constructor(message = "primaryIntakePhotoId does not reference a staged photo belonging to this intake.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationPrimaryInvalidError";
  }
}

/** Sprint 95: thrown when a staged photo's source file is missing or unreadable at promotion time - a data-integrity conflict, not an unexpected server failure. */
export class AiIntakePhotoFinalizationSourceMissingError extends ConflictError {
  constructor(message = "A staged photo's source file could not be read.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationSourceMissingError";
  }
}

/** Sprint 95: thrown when a deterministic canonical destination already exists with different bytes than the freshly-generated output - never silently overwritten. */
export class AiIntakePhotoFinalizationDestinationConflictError extends ConflictError {
  constructor(message = "A canonical photo destination already exists with different content.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationDestinationConflictError";
  }
}

/**
 * Sprint 95: thrown when the staged photo set re-read inside the
 * authoritative transaction no longer matches the prepared file manifest
 * (different staged photo ids, storage keys, order, or count than what was
 * prepared outside the transaction), or when a pre-existing ProductPhoto row
 * is found at a deterministic id before a first finalization attempt's
 * insert - both indicate the operation cannot safely proceed and must fail
 * before any write.
 */
export class AiIntakePhotoFinalizationStateInvalidError extends ConflictError {
  constructor(message = "The staged photo set changed. Retry finalization.") {
    super(message);
    this.name = "AiIntakePhotoFinalizationStateInvalidError";
  }
}

/**
 * Sprint 96: thrown when a non-dry-run Admin cleanup execute request is
 * received while AI_INTAKE_CLEANUP_EXECUTION_ENABLED is false - a deterministic
 * refusal, never a silent downgrade to dry-run and never a silent no-op
 * reported as success. Dry-run requests are never affected by this gate.
 */
export class AiIntakeCleanupExecutionDisabledError extends ConflictError {
  constructor(message = "AI intake cleanup execution is currently disabled.") {
    super(message);
    this.name = "AiIntakeCleanupExecutionDisabledError";
  }
}

/**
 * Sprint 96: thrown when a cleanup retention/grace duration environment
 * variable is set but does not parse to a finite positive number of
 * milliseconds - an unexpected server configuration failure (500), never a
 * client-facing 400, and never silently treated as "0" (which would make
 * every candidate immediately eligible for destructive cleanup).
 */
export class AiIntakeCleanupConfigurationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiIntakeCleanupConfigurationInvalidError";
  }
}

/**
 * Sprint 96: thrown when a staged AI intake photo DELETE (either the public
 * single-photo path or the internal bounded retention-cleanup path) does not
 * affect exactly the expected row(s) - a server integrity failure (500), not
 * a lifecycle conflict (409). The row/status allowlist checks that produce a
 * 409 AiIntakePhotoMutationNotAllowedError already ran before any DELETE
 * statement executes; reaching this error means the DELETE itself behaved
 * unexpectedly despite every precondition already having passed.
 */
export class AiIntakePhotoDeleteIntegrityFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiIntakePhotoDeleteIntegrityFailureError";
  }
}

/**
 * Sprint 101: thrown when AI_INTAKE_PROVIDER is set to an unsupported value,
 * or when AI_INTAKE_PROVIDER=openai but one or more of
 * AI_INTAKE_OPENAI_API_KEY / AI_INTAKE_OPENAI_MODEL / AI_INTAKE_OPENAI_MAX_PHOTOS
 * is missing or invalid. Always thrown before any network request is made
 * (see ai-intake/providerFactory.ts) - a deterministic server configuration
 * failure (500), never a client-facing 400. The message is always built from
 * fixed, app-controlled text only (env var names, never their values), so it
 * never risks echoing a secret.
 */
export class AiIntakeProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiIntakeProviderConfigurationError";
  }
}

/** Sprint 101: thrown when the real AI provider rejects the request as unauthenticated (HTTP 401/403) - never surfaces the API key or the provider's raw response body. */
export class AiIntakeProviderAuthenticationError extends Error {
  constructor(message = "The AI provider rejected the request as unauthenticated.") {
    super(message);
    this.name = "AiIntakeProviderAuthenticationError";
  }
}

/** Sprint 101: thrown for a network-level failure, timeout, rate limit (429), or any provider-side 5xx - never surfaces the raw error or response body. */
export class AiIntakeProviderUnavailableError extends Error {
  constructor(message = "The AI provider is temporarily unavailable. Try again later.") {
    super(message);
    this.name = "AiIntakeProviderUnavailableError";
  }
}

/** Sprint 101: thrown when the provider's response cannot be parsed, does not contain structured output text, or fails schema validation - the raw model/response body is never surfaced. */
export class AiIntakeProviderInvalidResponseError extends Error {
  constructor(message = "The AI provider returned an unusable response.") {
    super(message);
    this.name = "AiIntakeProviderInvalidResponseError";
  }
}

/**
 * Sprint 101: thrown by the real AI provider (never the Mock provider, which
 * has no configured limit) when an intake's current staged-photo count
 * exceeds AI_INTAKE_OPENAI_MAX_PHOTOS - rejected before any network request,
 * never silently truncated. Extends ConflictError since this is a
 * business-state precondition on the intake, not a malformed request body.
 */
export class AiIntakeProviderTooManyPhotosError extends ConflictError {
  constructor(maxPhotos: number, actualPhotos: number) {
    super(
      `This intake has ${actualPhotos} staged photos, which exceeds the configured AI provider limit of ${maxPhotos}. Remove photos before generating a proposal.`,
    );
    this.name = "AiIntakeProviderTooManyPhotosError";
  }
}
