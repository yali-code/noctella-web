export class SalesUseCaseError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = new.target.name; } }
export class SalesValidationError extends SalesUseCaseError { constructor(message: string) { super(message, "sales_validation"); } }
export class SaleNotFoundError extends SalesUseCaseError { constructor() { super("Sale not found", "sale_not_found"); } }
export class SaleConcurrencyConflictError extends SalesUseCaseError { constructor() { super("Sale version conflict", "sale_concurrency_conflict"); } }
export class SaleDuplicateReferenceError extends SalesUseCaseError { constructor() { super("Sale reference already exists", "sale_duplicate_reference"); } }
export class InvalidSaleStatusTransitionError extends SalesUseCaseError { constructor() { super("Invalid sale status transition", "invalid_sale_status_transition"); } }
export class InvalidSaleAmountError extends SalesUseCaseError { constructor(message = "Invalid sale amount") { super(message, "invalid_sale_amount"); } }
export class SalesCompletionCapabilityUnavailableError extends SalesUseCaseError {
  readonly metadata: Readonly<{ capability: string }>;
  constructor(capability: string) {
    super(`Sales completion capability unavailable: ${capability}`, "sales_completion_capability_unavailable");
    this.metadata = Object.freeze({ capability });
  }
}
export class SalesCompletionCoordinationError extends SalesUseCaseError {
  readonly metadata: Readonly<{ capability: string; causeCode: string | null }>;
  constructor(capability: string, causeCode: string | null = null) {
    super(`Sales completion coordination failed: ${capability}`, "sales_completion_coordination_error");
    this.metadata = Object.freeze({ capability, causeCode });
  }
}
export class SalesCompletionIdempotencyConflictError extends SalesUseCaseError {
  readonly metadata: Readonly<{ idempotencyKey: string }>;
  constructor(idempotencyKey: string) {
    super("Completion idempotency key was already used with a different payload", "sales_completion_idempotency_conflict");
    this.metadata = Object.freeze({ idempotencyKey });
  }
}
export class SaleAlreadyCompletedConflictError extends SalesUseCaseError {
  readonly metadata: Readonly<{ saleId: string; completedWithIdempotencyKey: string }>;
  constructor(saleId: string, completedWithIdempotencyKey: string) {
    super("Sale was already completed with a different idempotency key", "sale_already_completed_conflict");
    this.metadata = Object.freeze({ saleId, completedWithIdempotencyKey });
  }
}
export class SalesCompletionReadinessError extends SalesUseCaseError {
  constructor() { super("Sale is not ready for completion", "sales_completion_readiness"); }
}
