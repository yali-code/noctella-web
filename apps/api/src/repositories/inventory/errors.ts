export class InventoryRepositoryError extends Error { constructor(message:string, readonly code:string){ super(message); this.name=this.constructor.name; } }
export class ProductNotFoundError extends InventoryRepositoryError { constructor(id:string){ super(`Product not found: ${id}`,"PRODUCT_NOT_FOUND"); } }
export class DuplicateSkuError extends InventoryRepositoryError { constructor(sku:string){ super(`Duplicate SKU: ${sku}`,"DUPLICATE_SKU"); } }
export class StaleProductVersionError extends InventoryRepositoryError { constructor(id:string){ super(`Stale product version: ${id}`,"STALE_PRODUCT_VERSION"); } }
export class InventoryNotFoundError extends InventoryRepositoryError { constructor(productId:string){ super(`Inventory not found: ${productId}`,"INVENTORY_NOT_FOUND"); } }
export class InsufficientStockError extends InventoryRepositoryError { constructor(productId:string){ super(`Insufficient stock: ${productId}`,"INSUFFICIENT_STOCK"); } }
export class StaleInventoryVersionError extends InventoryRepositoryError { constructor(productId:string){ super(`Stale inventory version: ${productId}`,"STALE_INVENTORY_VERSION"); } }
export class InventoryIdempotencyConflictError extends InventoryRepositoryError { constructor(key:string){ super(`Idempotency conflict: ${key}`,"INVENTORY_IDEMPOTENCY_CONFLICT"); } }
export class StockLocationNotFoundError extends InventoryRepositoryError { constructor(id:string){ super(`Stock location not found: ${id}`,"STOCK_LOCATION_NOT_FOUND"); } }
export class DuplicateStockLocationCodeError extends InventoryRepositoryError { constructor(code:string){ super(`Duplicate stock location code: ${code}`,"DUPLICATE_STOCK_LOCATION_CODE"); } }
