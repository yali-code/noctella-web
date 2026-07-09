export enum ProductStatus {
  Draft = "draft",
  AiPrepared = "ai_prepared",
  PendingReview = "pending_review",
  Approved = "approved",
  Published = "published",
  Reserved = "reserved",
  Sold = "sold",
  Archived = "archived",
  Returned = "returned",
}

export const PRODUCT_STATUS_VALUES: ProductStatus[] = Object.values(ProductStatus);
