export class PurchaseUseCaseError extends Error{constructor(message:string,readonly code:string){super(message);this.name=this.constructor.name}}
export class PurchaseValidationError extends PurchaseUseCaseError{constructor(message="Invalid purchase input"){super(message,"purchase_validation")}}
export class PurchaseNotFoundError extends PurchaseUseCaseError{constructor(){super("Purchase not found","purchase_not_found")}}
export class SupplierNotFoundError extends PurchaseUseCaseError{constructor(){super("Supplier not found","supplier_not_found")}}
export class PurchaseConcurrencyConflictError extends PurchaseUseCaseError{constructor(){super("Purchase changed since expected version","purchase_concurrency_conflict")}}
export class PurchaseDuplicateReferenceError extends PurchaseUseCaseError{constructor(){super("Purchase reference already exists","purchase_duplicate_reference")}}
export class SupplierDuplicateReferenceError extends PurchaseUseCaseError{constructor(){super("Supplier reference already exists","supplier_duplicate_reference")}}
export class InvalidPurchaseStatusTransitionError extends PurchaseUseCaseError{constructor(message="Invalid purchase status transition"){super(message,"purchase_status_transition")}}
export class InvalidPurchaseQuantityError extends PurchaseUseCaseError{constructor(message="Invalid purchase quantity"){super(message,"purchase_quantity")}}
export class PurchaseReceiptConflictError extends PurchaseUseCaseError{constructor(){super("Purchase receipt idempotency conflict","purchase_receipt_conflict")}}
