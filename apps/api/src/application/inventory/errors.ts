export class InventoryUseCaseError extends Error { constructor(message:string, readonly code:string){ super(message); this.name=this.constructor.name; } }
export class InvalidInventoryQuantityError extends InventoryUseCaseError { constructor(message="Invalid inventory quantity"){ super(message,"INVALID_INVENTORY_QUANTITY"); } }
export class InvalidSkuError extends InventoryUseCaseError { constructor(){ super("Invalid SKU","INVALID_SKU"); } }
export class ProductAlreadyExistsError extends InventoryUseCaseError { constructor(){ super("Product already exists","PRODUCT_ALREADY_EXISTS"); } }
export class ProductNotFoundApplicationError extends InventoryUseCaseError { constructor(){ super("Product not found","PRODUCT_NOT_FOUND"); } }
export class InventoryNotInitializedError extends InventoryUseCaseError { constructor(){ super("Inventory not initialized","INVENTORY_NOT_INITIALIZED"); } }
export class InventoryAlreadyInitializedError extends InventoryUseCaseError { constructor(){ super("Inventory already initialized","INVENTORY_ALREADY_INITIALIZED"); } }
export class InsufficientInventoryError extends InventoryUseCaseError { constructor(){ super("Insufficient inventory","INSUFFICIENT_INVENTORY"); } }
export class InventoryVersionConflictError extends InventoryUseCaseError { constructor(){ super("Inventory version conflict","INVENTORY_VERSION_CONFLICT"); } }
export class InventoryOperationConflictError extends InventoryUseCaseError { constructor(){ super("Inventory operation conflict","INVENTORY_OPERATION_CONFLICT"); } }
export class StockLocationNotFoundApplicationError extends InventoryUseCaseError { constructor(){ super("Stock location not found","STOCK_LOCATION_NOT_FOUND"); } }
export class InvalidStockTransferError extends InventoryUseCaseError { constructor(message="Invalid stock transfer"){ super(message,"INVALID_STOCK_TRANSFER"); } }
