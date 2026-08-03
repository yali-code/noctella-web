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
