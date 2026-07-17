export class SaleRepositoryError extends Error{constructor(message:string,readonly code:string){super(message)}}
export class SaleNotFoundRepositoryError extends SaleRepositoryError{constructor(){super("Sale not found","not_found")}}
export class SaleConcurrencyConflictRepositoryError extends SaleRepositoryError{constructor(){super("Sale version conflict","optimistic_conflict")}}
export class SaleDuplicateReferenceRepositoryError extends SaleRepositoryError{constructor(){super("Sale reference already exists","duplicate_reference")}}
export class SaleDuplicateExternalOrderRepositoryError extends SaleRepositoryError{constructor(){super("Sale external order already exists","duplicate_external_order")}}
export class SaleDuplicateIdempotencyKeyRepositoryError extends SaleRepositoryError{constructor(){super("Sale idempotency key already exists","duplicate_idempotency_key")}}
