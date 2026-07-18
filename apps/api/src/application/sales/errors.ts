export class SalesUseCaseError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = new.target.name; } }
export class SalesValidationError extends SalesUseCaseError { constructor(message: string) { super(message, "sales_validation"); } }
export class SaleNotFoundError extends SalesUseCaseError { constructor() { super("Sale not found", "sale_not_found"); } }
export class SaleConcurrencyConflictError extends SalesUseCaseError { constructor() { super("Sale version conflict", "sale_concurrency_conflict"); } }
export class SaleDuplicateReferenceError extends SalesUseCaseError { constructor() { super("Sale reference already exists", "sale_duplicate_reference"); } }
export class InvalidSaleStatusTransitionError extends SalesUseCaseError { constructor() { super("Invalid sale status transition", "invalid_sale_status_transition"); } }
export class InvalidSaleAmountError extends SalesUseCaseError { constructor(message = "Invalid sale amount") { super(message, "invalid_sale_amount"); } }
