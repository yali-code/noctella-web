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
