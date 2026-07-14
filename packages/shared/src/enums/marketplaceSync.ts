export enum MarketplaceWebhookEventType { OrderCreated = "order_created", OrderPaid = "order_paid", ListingUpdated = "listing_updated", Unsupported = "unsupported" }
export enum MarketplaceWebhookEventStatus { Pending = "pending", Processing = "processing", Processed = "processed", Failed = "failed", Ignored = "ignored" }
export enum MarketplaceOrderStatus { Pending = "pending", Paid = "paid", Processing = "processing", Shipped = "shipped", Cancelled = "cancelled", Refunded = "refunded" }
export enum MarketplaceSyncStatus { Pending = "pending", Processing = "processing", Succeeded = "succeeded", Failed = "failed", Partial = "partial" }
export enum MarketplaceSyncError { Validation = "Validation", Signature = "Signature", Authentication = "Authentication", Authorization = "Authorization", NotFound = "NotFound", RateLimit = "RateLimit", Timeout = "Timeout", Temporary = "Temporary", Permanent = "Permanent", Stock = "Stock", Currency = "Currency", Unknown = "Unknown" }
export enum ExternalListingSyncState { Unchanged = "unchanged", Changed = "changed", Failed = "failed" }
export const MARKETPLACE_WEBHOOK_EVENT_STATUS_VALUES = Object.values(MarketplaceWebhookEventStatus);
export const MARKETPLACE_ORDER_STATUS_VALUES = Object.values(MarketplaceOrderStatus);
export const MARKETPLACE_SYNC_STATUS_VALUES = Object.values(MarketplaceSyncStatus);
