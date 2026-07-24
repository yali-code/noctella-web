// Sprint 64D: category classifies each subtype for centralized HTTP mapping in
// routes/errorHandler.ts (validation -> 400, not_found -> 404, conflict -> 409). Kept on the
// base class rather than duplicated per-route so every existing throw site is covered without
// modification.
export type InventoryErrorCategory = "validation" | "not_found" | "conflict";
export class InventoryUseCaseError extends Error { constructor(message:string, readonly code:string, readonly category:InventoryErrorCategory){ super(message); this.name=this.constructor.name; } }
export class InvalidInventoryQuantityError extends InventoryUseCaseError { constructor(message="Invalid inventory quantity"){ super(message,"INVALID_INVENTORY_QUANTITY","validation"); } }
export class InvalidSkuError extends InventoryUseCaseError { constructor(){ super("Invalid SKU","INVALID_SKU","validation"); } }
export class ProductAlreadyExistsError extends InventoryUseCaseError { constructor(){ super("Product already exists","PRODUCT_ALREADY_EXISTS","conflict"); } }
export class ProductNotFoundApplicationError extends InventoryUseCaseError { constructor(){ super("Product not found","PRODUCT_NOT_FOUND","not_found"); } }
export class InventoryNotInitializedError extends InventoryUseCaseError { constructor(){ super("Inventory not initialized","INVENTORY_NOT_INITIALIZED","not_found"); } }
export class InventoryAlreadyInitializedError extends InventoryUseCaseError { constructor(){ super("Inventory already initialized","INVENTORY_ALREADY_INITIALIZED","conflict"); } }
export class InsufficientInventoryError extends InventoryUseCaseError { constructor(){ super("Insufficient inventory","INSUFFICIENT_INVENTORY","conflict"); } }
export class InventoryVersionConflictError extends InventoryUseCaseError { constructor(){ super("Inventory version conflict","INVENTORY_VERSION_CONFLICT","conflict"); } }
export class InventoryOperationConflictError extends InventoryUseCaseError { constructor(){ super("Inventory operation conflict","INVENTORY_OPERATION_CONFLICT","conflict"); } }
export class StockLocationNotFoundApplicationError extends InventoryUseCaseError { constructor(){ super("Stock location not found","STOCK_LOCATION_NOT_FOUND","not_found"); } }
export class InvalidStockTransferError extends InventoryUseCaseError { constructor(message="Invalid stock transfer"){ super(message,"INVALID_STOCK_TRANSFER","validation"); } }
