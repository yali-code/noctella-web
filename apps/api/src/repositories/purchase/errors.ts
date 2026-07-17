export class PurchaseRepositoryError extends Error{constructor(message:string,readonly code:string){super(message)}}
export class DuplicatePurchaseReferenceError extends PurchaseRepositoryError{constructor(){super("Purchase reference already exists","duplicate_purchase_reference")}}
export class DuplicateSupplierCodeError extends PurchaseRepositoryError{constructor(){super("Supplier code already exists","duplicate_supplier_code")}}
export class PurchaseReceiptIdempotencyConflictError extends PurchaseRepositoryError{constructor(){super("Purchase receipt idempotency key already exists","purchase_receipt_idempotency_conflict")}}
