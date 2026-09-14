/** Persistence-level outbox values shared by repositories and service orchestration. */
export enum OutboxEventStatus {
  Pending = "Pending",
  Processing = "Processing",
  Succeeded = "Succeeded",
  RetryPending = "RetryPending",
  Failed = "Failed",
  DeadLetter = "DeadLetter",
  Cancelled = "Cancelled",
}

export enum OutboxEventType {
  ProductPhotoPromoteRequested = "product_photo.promote_requested",
  ProductPhotoDeleteRequested = "product_photo.delete_requested",
  ProductPhotoCleanupTempRequested = "product_photo.cleanup_temp_requested",
  SalesInvoiceDraftRequested = "sales_invoice.draft_requested",
  AiSalesPreparationRequested = "ai_sales_preparation.requested",
  StockSyncRequested = "stock_sync.requested",
}
