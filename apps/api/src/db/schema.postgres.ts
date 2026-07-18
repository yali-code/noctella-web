import { pgTable, text, integer, numeric, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const postgresTypeMappings = { id: "text primary key", text: "text", integer: "integer", boolean: "boolean", timestamp: "timestamptz", json: "jsonb", money: "numeric(12,2)", decimal: "numeric(18,6)" };
export const migrationTransformations = ["boolean integer → boolean","text timestamps → timestamptz","JSON-encoded text → jsonb","numeric real → numeric/decimal for money and quantity cost fields","empty string vs null normalization without fake values","case-sensitive uniqueness reviewed for invoice number, SKU, ERP references and idempotency keys"];
export const schemaVersion = "sprint-24-postgres-foundation";
export const categories = pgTable("categories", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  parentId: text("parent_id"),
  displayImageUrl: text("display_image_url"),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const collections = pgTable("collections", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  coverImageUrl: text("cover_image_url"),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const products = pgTable("products", {
  id: text("id").primaryKey().notNull(),
  erpReferenceId: text("erp_reference_id"),
  sku: text("sku").notNull().unique(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  categoryId: text("category_id"),
  collectionId: text("collection_id"),
  brand: text("brand"),
  model: text("model"),
  manufacturer: text("manufacturer"),
  countryOfOrigin: text("country_of_origin"),
  period: text("period"),
  materials: text("materials"),
  description: text("description"),
  productStory: text("product_story"),
  condition: text("condition"),
  conditionDescription: text("condition_description"),
  lengthValue: numeric("length_value", { precision: 18, scale: 6 }),
  widthValue: numeric("width_value", { precision: 18, scale: 6 }),
  heightValue: numeric("height_value", { precision: 18, scale: 6 }),
  dimensionUnit: text("dimension_unit"),
  weightValue: numeric("weight_value", { precision: 18, scale: 6 }),
  weightUnit: numeric("weight_unit", { precision: 18, scale: 6 }),
  stockQuantity: integer("stock_quantity").notNull().default(1),
  lotItemCount: integer("lot_item_count"),
  purchaseCost: numeric("purchase_cost", { precision: 18, scale: 6 }),
  purchaseCurrency: text("purchase_currency"),
  internalNotes: text("internal_notes"),
  priceEur: numeric("price_eur", { precision: 18, scale: 6 }).notNull(),
  priceUsd: numeric("price_usd", { precision: 18, scale: 6 }),
  minOfferPrice: numeric("min_offer_price", { precision: 18, scale: 6 }),
  videoUrl: text("video_url"),
  shippingProfile: text("shipping_profile"),
  shippingNote: text("shipping_note"),
  customsWarning: integer("customs_warning").notNull().default(0),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  keywords: text("keywords"),
  isFeatured: integer("is_featured").notNull().default(0),
  allowMakeOffer: integer("allow_make_offer").notNull().default(0),
  allowCashOnDelivery: integer("allow_cash_on_delivery").notNull().default(0),
  showInArchiveAfterSale: integer("show_in_archive_after_sale").notNull().default(0),
  ebayTitle: text("ebay_title"),
  ebaySubtitle: text("ebay_subtitle"),
  ebayDescription: text("ebay_description"),
  ebayConditionDescription: text("ebay_condition_description"),
  ebayCategory: text("ebay_category"),
  ebayItemSpecifics: text("ebay_item_specifics"),
  ebayListingPriceEur: numeric("ebay_listing_price_eur", { precision: 18, scale: 6 }),
  ebayListingStatus: text("ebay_listing_status"),
  etsyTitle: text("etsy_title"),
  etsyDescription: text("etsy_description"),
  etsyTags: text("etsy_tags"),
  etsyMaterials: text("etsy_materials"),
  etsyStyle: text("etsy_style"),
  etsyOccasion: text("etsy_occasion"),
  etsyListingPriceEur: numeric("etsy_listing_price_eur", { precision: 18, scale: 6 }),
  etsyListingStatus: text("etsy_listing_status"),
  wooProductName: text("woo_product_name"),
  wooShortDescription: text("woo_short_description"),
  wooLongDescription: text("woo_long_description"),
  wooSlug: text("woo_slug"),
  wooSeoTitle: text("woo_seo_title"),
  wooMetaDescription: text("woo_meta_description"),
  wooFocusKeyword: text("woo_focus_keyword"),
  wooListingPriceEur: numeric("woo_listing_price_eur", { precision: 18, scale: 6 }),
  wooListingStatus: text("woo_listing_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const productPhotos = pgTable("product_photos", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  url: text("url").notNull(),
  thumbnailUrl: text("thumbnail_url").notNull(),
  altText: text("alt_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: integer("is_primary").notNull().default(0),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  processingStatus: text("processing_status").notNull().default("Ready"),
  storageKey: text("storage_key"),
  thumbnailStorageKey: text("thumbnail_storage_key"),
  processingErrorCode: text("processing_error_code"),
  processingUpdatedAt: timestamp("processing_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});


export const outboxEvents = pgTable("outbox_events", {
  id: text("id").primaryKey().notNull(),
  eventType: text("event_type").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
}, (table) => [
  index("idx_outbox_events_due").on(table.status, table.availableAt),
  index("idx_outbox_events_type").on(table.eventType),
  index("idx_outbox_events_aggregate").on(table.aggregateType, table.aggregateId),
  index("idx_outbox_events_locked").on(table.lockedAt),
]);

export const outboxAttempts = pgTable("outbox_attempts", {
  id: text("id").primaryKey().notNull(),
  outboxEventId: text("outbox_event_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  result: text("result").notNull(),
  safeErrorCode: text("safe_error_code"),
  safeErrorMessage: text("safe_error_message"),
}, (table) => [index("idx_outbox_attempts_event").on(table.outboxEventId)]);

export const productImages = pgTable("product_images", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  url: text("url").notNull(),
  altText: text("alt_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: integer("is_primary").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const aiListingDrafts = pgTable("ai_listing_drafts", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  status: text("status").notNull(),
  generatedTitle: text("generated_title"),
  generatedDescription: text("generated_description"),
  generatedStory: text("generated_story"),
  generatedConditionDescription: text("generated_condition_description"),
  suggestedCategoryId: text("suggested_category_id"),
  suggestedCollectionId: text("suggested_collection_id"),
  suggestedEurPrice: numeric("suggested_eur_price", { precision: 18, scale: 6 }),
  suggestedUsdPrice: numeric("suggested_usd_price", { precision: 18, scale: 6 }),
  suggestedMinimumOfferPrice: numeric("suggested_minimum_offer_price", { precision: 18, scale: 6 }),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  keywords: text("keywords"),
  shippingNote: text("shipping_note"),
  customsWarning: integer("customs_warning"),
  aiConfidenceScore: numeric("ai_confidence_score", { precision: 18, scale: 6 }),
  aiModel: text("ai_model"),
  generationPromptVersion: text("generation_prompt_version"),
  rejectionReason: text("rejection_reason"),
  reviewedByAdminUserId: text("reviewed_by_admin_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const offers = pgTable("offers", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  offeredAmount: numeric("offered_amount", { precision: 18, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  message: text("message"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const orders = pgTable("orders", {
  id: text("id").primaryKey().notNull(),
  orderNumber: text("order_number").notNull().unique(),
  orderDraftId: text("order_draft_id").unique(),
  customerId: text("customer_id"),
  guestEmail: text("guest_email").notNull(),
  status: text("status").notNull(),
  paymentStatus: text("payment_status").notNull(),
  paymentProvider: text("payment_provider"),
  paymentReference: text("payment_reference"),
  subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 6 }).notNull(),
  shippingAmount: numeric("shipping_amount", { precision: 18, scale: 6 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 6 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 18, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  billingAddress: jsonb("billing_address").notNull(),
  shippingAddress: jsonb("shipping_address").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const orderItems = pgTable("order_items", {
  id: text("id").primaryKey().notNull(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  productSku: text("product_sku").notNull(),
  productTitle: text("product_title").notNull(),
  productSlug: text("product_slug").notNull(),
  productType: text("product_type").notNull(),
  productImageUrl: text("product_image_url"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 18, scale: 6 }).notNull(),
  totalPrice: numeric("total_price", { precision: 18, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const payments = pgTable("payments", {
  id: text("id").primaryKey().notNull(),
  orderId: text("order_id"),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
  currency: text("currency").notNull().default("EUR"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  safeMetadata: jsonb("safe_metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const stockMovements = pgTable("stock_movements", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  type: text("type").notNull(),
  quantityDelta: integer("quantity_delta").notNull(),
  stockBefore: integer("stock_before").notNull(),
  stockAfter: integer("stock_after").notNull(),
  orderId: text("order_id"),
  orderItemId: text("order_item_id"),
  note: text("note"),
  createdByAdminUserId: text("created_by_admin_user_id"),
  idempotencyKey: text("idempotency_key").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const marketplaceConnections = pgTable("marketplace_connections", {
  id: text("id").primaryKey().notNull(),
  channel: text("channel").notNull(),
  accountLabel: text("account_label").notNull(),
  externalAccountId: text("external_account_id"),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  scopes: text("scopes"),
  status: text("status").notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const publishJobs = pgTable("publish_jobs", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payloadSnapshot: jsonb("payload_snapshot").notNull(),
  externalListingId: text("external_listing_id"),
  externalListingUrl: text("external_listing_url"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const publishAttempts = pgTable("publish_attempts", {
  id: text("id").primaryKey().notNull(),
  publishJobId: text("publish_job_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  requestSnapshot: jsonb("request_snapshot").notNull(),
  responseSnapshot: jsonb("response_snapshot"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const externalListings = pgTable("external_listings", {
  id: text("id").primaryKey().notNull(),
  productId: text("product_id").notNull(),
  channel: text("channel").notNull(),
  connectionId: text("connection_id").notNull(),
  externalListingId: text("external_listing_id").notNull(),
  externalListingUrl: text("external_listing_url"),
  externalStatus: text("external_status").notNull(),
  payloadSnapshot: jsonb("payload_snapshot").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const marketplaceWebhookEvents = pgTable("marketplace_webhook_events", {
  id: text("id").primaryKey().notNull(),
  channel: text("channel").notNull(),
  externalEventId: text("external_event_id").notNull(),
  eventType: text("event_type").notNull(),
  status: text("status").notNull(),
  signatureValid: integer("signature_valid").notNull().default(0),
  payloadSnapshot: jsonb("payload_snapshot").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const marketplaceOrders = pgTable("marketplace_orders", {
  id: text("id").primaryKey().notNull(),
  channel: text("channel").notNull(),
  externalOrderId: text("external_order_id").notNull(),
  externalOrderNumber: text("external_order_number"),
  marketplaceConnectionId: text("marketplace_connection_id").notNull(),
  internalOrderId: text("internal_order_id"),
  status: text("status").notNull(),
  importStatus: text("import_status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  lastErrorType: text("last_error_type"),
  retryable: integer("retryable").notNull().default(1),
  currency: text("currency").notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 6 }).notNull(),
  shipping: numeric("shipping", { precision: 18, scale: 6 }).notNull().default("0"),
  tax: numeric("tax", { precision: 18, scale: 6 }).notNull().default("0"),
  total: numeric("total", { precision: 18, scale: 6 }).notNull(),
  buyerEmail: text("buyer_email"),
  buyerName: text("buyer_name"),
  shippingAddressSnapshot: jsonb("shipping_address_snapshot"),
  billingAddressSnapshot: jsonb("billing_address_snapshot"),
  rawPayloadSnapshot: jsonb("raw_payload_snapshot").notNull(),
  orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const marketplaceOrderItems = pgTable("marketplace_order_items", {
  id: text("id").primaryKey().notNull(),
  marketplaceOrderId: text("marketplace_order_id").notNull(),
  externalOrderItemId: text("external_order_item_id"),
  externalListingId: text("external_listing_id"),
  productId: text("product_id"),
  sku: text("sku"),
  titleSnapshot: jsonb("title_snapshot").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 18, scale: 6 }).notNull(),
  lineTotal: numeric("line_total", { precision: 18, scale: 6 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const marketplaceSyncRuns = pgTable("marketplace_sync_runs", {
  id: text("id").primaryKey().notNull(),
  channel: text("channel").notNull(),
  syncType: text("sync_type").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  processedCount: integer("processed_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const marketplaceImportAttempts = pgTable("marketplace_import_attempts", {
  id: text("id").primaryKey().notNull(),
  marketplaceOrderId: text("marketplace_order_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull(),
  errorType: text("error_type"),
  errorMessage: text("error_message"),
  retryable: integer("retryable").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const backgroundJobs = pgTable("background_jobs", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const marketplaceInventorySnapshots = pgTable("marketplace_inventory_snapshots", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const stockSyncConflicts = pgTable("stock_sync_conflicts", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const stockSyncAudit = pgTable("stock_sync_audit", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const shipments = pgTable("shipments", {
  id: text("id").primaryKey().notNull(),
  orderId: text("order_id").notNull(),
  marketplaceOrderId: text("marketplace_order_id"),
  channel: text("channel"),
  carrierCode: text("carrier_code").notNull(),
  customCarrierName: text("custom_carrier_name"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  status: text("status").notNull(),
  shippingCost: numeric("shipping_cost", { precision: 18, scale: 6 }).notNull().default("0"),
  currency: text("currency").notNull().default("EUR"),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  externalFulfillmentId: text("external_fulfillment_id"),
  marketplaceFulfillmentStatus: text("marketplace_fulfillment_status"),
  lastError: text("last_error"),
  customsSnapshot: jsonb("customs_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const shipmentItems = pgTable("shipment_items", {
  id: text("id").primaryKey().notNull(),
  shipmentId: text("shipment_id").notNull(),
  orderItemId: text("order_item_id").notNull(),
  quantity: integer("quantity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const shipmentEvents = pgTable("shipment_events", {
  id: text("id").primaryKey().notNull(),
  shipmentId: text("shipment_id").notNull(),
  eventType: text("event_type").notNull(),
  previousStatus: text("previous_status"),
  newStatus: text("new_status"),
  payloadSnapshot: jsonb("payload_snapshot"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const shipmentTrackingUpdates = pgTable("shipment_tracking_updates", {
  id: text("id").primaryKey().notNull(),
  shipmentId: text("shipment_id").notNull(),
  source: text("source").notNull(),
  externalStatus: text("external_status"),
  normalizedStatus: text("normalized_status"),
  location: text("location"),
  description: text("description"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  payloadSnapshot: jsonb("payload_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const saleFinancials = pgTable("sale_financials", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});
export const saleCompletionExecutions = pgTable("sale_completion_executions", {
  idempotencyKey: text("idempotency_key").primaryKey().notNull(),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  saleId: text("sale_id").notNull(),
  resultPayload: jsonb("result_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [index("idx_sale_completion_executions_sale").on(table.saleId)]);

export const returnRequests = pgTable("return_requests", { id: text("id").primaryKey().notNull(), orderId: text("order_id").notNull(), marketplaceOrderId: text("marketplace_order_id"), shipmentId: text("shipment_id"), channel: text("channel"), externalReturnId: text("external_return_id"), externalReturnNumber: text("external_return_number"), externalReference: text("external_reference"), idempotencyKey: text("idempotency_key"), status: text("status").notNull(), reason: text("reason").notNull(), reasonDetails: text("reason_details"), requestedResolution: text("requested_resolution").notNull(), approvedResolution: text("approved_resolution"), buyerMessage: text("buyer_message"), internalNote: text("internal_note"), requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(), authorizedAt: timestamp("authorized_at", { withTimezone: true }), receivedAt: timestamp("received_at", { withTimezone: true }), inspectedAt: timestamp("inspected_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }), cancelledAt: timestamp("cancelled_at", { withTimezone: true }), returnCarrierCode: text("return_carrier_code"), returnTrackingNumber: text("return_tracking_number"), returnTrackingUrl: text("return_tracking_url"), buyerShippedAt: timestamp("buyer_shipped_at", { withTimezone: true }), lastError: text("last_error"), version: integer("version").notNull().default(0), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_return_requests_order").on(table.orderId), index("idx_return_requests_status").on(table.status), uniqueIndex("idx_return_requests_idempotency").on(table.idempotencyKey)]);

export const returnItems = pgTable("return_items", { id: text("id").primaryKey().notNull(), returnRequestId: text("return_request_id").notNull(), orderItemId: text("order_item_id").notNull(), productId: text("product_id"), quantityRequested: integer("quantity_requested").notNull(), quantityApproved: integer("quantity_approved"), quantityReceived: integer("quantity_received"), quantityCompleted: integer("quantity_completed"), condition: text("condition"), stockDisposition: text("stock_disposition"), inspectionNote: text("inspection_note"), inspectionResult: jsonb("inspection_result"), completedAt: timestamp("completed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_return_items_request").on(table.returnRequestId), index("idx_return_items_order_item").on(table.orderItemId), index("idx_return_items_product").on(table.productId)]);

export const returnEvents = pgTable("return_events", { id: text("id").primaryKey().notNull(), returnRequestId: text("return_request_id").notNull(), orderId: text("order_id"), eventType: text("event_type").notNull(), previousStatus: text("previous_status"), newStatus: text("new_status"), payloadSnapshot: jsonb("payload_snapshot"), errorCode: text("error_code"), errorMessage: text("error_message"), idempotencyKey: text("idempotency_key"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_return_events_request").on(table.returnRequestId, table.createdAt), uniqueIndex("idx_return_events_idempotency").on(table.idempotencyKey)]);

export const refunds = pgTable("refunds", { id: text("id").primaryKey().notNull(), orderId: text("order_id").notNull(), returnRequestId: text("return_request_id"), channel: text("channel"), externalRefundId: text("external_refund_id"), type: text("type").notNull(), status: text("status").notNull(), currency: text("currency").notNull().default("EUR"), subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 6 }).notNull(), shippingAmount: numeric("shipping_amount", { precision: 18, scale: 6 }).notNull().default("0"), taxAmount: numeric("tax_amount", { precision: 18, scale: 6 }).notNull().default("0"), marketplaceFeeAdjustment: numeric("marketplace_fee_adjustment", { precision: 18, scale: 6 }), paymentFeeAdjustment: numeric("payment_fee_adjustment", { precision: 18, scale: 6 }), totalAmount: numeric("total_amount", { precision: 18, scale: 6 }).notNull(), reason: text("reason"), idempotencyKey: text("idempotency_key").notNull(), submittedAt: timestamp("submitted_at", { withTimezone: true }), succeededAt: timestamp("succeeded_at", { withTimezone: true }), failedAt: timestamp("failed_at", { withTimezone: true }), lastError: text("last_error"), version: integer("version").notNull().default(0), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_refunds_order").on(table.orderId), index("idx_refunds_return").on(table.returnRequestId), index("idx_refunds_status").on(table.status), uniqueIndex("idx_refunds_idempotency").on(table.idempotencyKey)]);

export const refundAllocations = pgTable("refund_allocations", { id: text("id").primaryKey().notNull(), refundId: text("refund_id").notNull(), orderItemId: text("order_item_id"), returnItemId: text("return_item_id"), quantity: integer("quantity"), amount: numeric("amount", { precision: 18, scale: 6 }).notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_refund_allocations_refund").on(table.refundId)]);

export const refundEvents = pgTable("refund_events", { id: text("id").primaryKey().notNull(), refundId: text("refund_id").notNull(), orderId: text("order_id"), eventType: text("event_type").notNull(), previousStatus: text("previous_status"), newStatus: text("new_status"), payloadSnapshot: jsonb("payload_snapshot"), actor: text("actor"), source: text("source"), idempotencyKey: text("idempotency_key"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_refund_events_refund").on(table.refundId, table.createdAt), uniqueIndex("idx_refund_events_idempotency").on(table.idempotencyKey)]);

export const saleReversals = pgTable("sale_reversals", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const refundAttempts = pgTable("refund_attempts", { id: text("id").primaryKey().notNull(), refundId: text("refund_id").notNull(), attemptNumber: integer("attempt_number").notNull(), channel: text("channel"), status: text("status").notNull(), externalRefundId: text("external_refund_id"), requestSnapshot: jsonb("request_snapshot").notNull(), responseSnapshot: jsonb("response_snapshot"), errorCode: text("error_code"), errorMessage: text("error_message"), orderId: text("order_id"), idempotencyKey: text("idempotency_key"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`) }, (table) => [index("idx_refund_attempts_refund").on(table.refundId), index("idx_refund_attempts_status").on(table.status)]);

export const erpIntegrationClients = pgTable("erp_integration_clients", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const erpIntegrationAudit = pgTable("erp_integration_audit", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const erpSyncCheckpoints = pgTable("erp_sync_checkpoints", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const erpCommandExecutions = pgTable("erp_command_executions", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const productErpMetadata = pgTable("product_erp_metadata", {
  productId: numeric("product_id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const purchases = pgTable("purchases", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const purchaseLines = pgTable("purchase_lines", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const purchaseAllocations = pgTable("purchase_allocations", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const purchaseReceipts = pgTable("purchase_receipts", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const purchaseReceiptLines = pgTable("purchase_receipt_lines", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const purchaseEvents = pgTable("purchase_events", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const customers = pgTable("customers", {
  id: text("id").primaryKey().notNull(),
  email: text("email"),
  displayName: text("display_name"),
  phone: text("phone"),
  erpReferenceId: text("erp_reference_id").unique(),
  safeMetadata: jsonb("safe_metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const customerAddresses = pgTable("customer_addresses", {
  id: text("id").primaryKey().notNull(),
});

export const customerConsents = pgTable("customer_consents", {
  id: text("id").primaryKey().notNull(),
});

export const customerEvents = pgTable("customer_events", {
  id: text("id").primaryKey().notNull(),
});

export const erpCustomerLinks = pgTable("erp_customer_links", {
  id: text("id").primaryKey().notNull(),
  customerId: text("customer_id").notNull(),
  erpReferenceId: text("erp_reference_id").notNull().unique(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const invoices = pgTable("invoices", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const invoiceLines = pgTable("invoice_lines", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const invoiceEvents = pgTable("invoice_events", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const financeEntries = pgTable("finance_entries", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const warehouses = pgTable("warehouses", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const warehouseLocations = pgTable("warehouse_locations", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const stockReservations = pgTable("stock_reservations", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const pickingTasks = pgTable("picking_tasks", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});

export const pickingTaskLines = pgTable("picking_task_lines", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const packingTasks = pgTable("packing_tasks", {
  id: numeric("id", { precision: 18, scale: 6 }).primaryKey().notNull().default(sql`now()`),
});

export const packingTaskLines = pgTable("packing_task_lines", {
  id: integer("id").primaryKey().notNull().default(sql`now()`),
});

export const warehouseEvents = pgTable("warehouse_events", {
  id: text("id").primaryKey().notNull().default(sql`now()`),
});
