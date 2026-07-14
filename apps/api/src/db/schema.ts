import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Sprint 2 persistence: SQLite via Drizzle ORM. Schema mirrors the shapes in
 * @noctella/shared (Product, ProductImage, Category, Collection). Enum-like
 * fields are stored as text and validated at the application layer (zod)
 * against the shared enum values, since SQLite has no native enum type.
 *
 * Chosen to keep a straightforward future migration path to PostgreSQL:
 * column names/types map directly, and swapping the driver only requires
 * changing db/client.ts plus the drizzle-kit dialect.
 */

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  parentId: text("parent_id"),
  displayImageUrl: text("display_image_url"),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  coverImageUrl: text("cover_image_url"),
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  erpReferenceId: text("erp_reference_id"),

  // Core
  sku: text("sku").notNull().unique(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  categoryId: text("category_id"),
  collectionId: text("collection_id"),

  // Product details
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

  // Physical information
  lengthValue: real("length_value"),
  widthValue: real("width_value"),
  heightValue: real("height_value"),
  dimensionUnit: text("dimension_unit"),
  weightValue: real("weight_value"),
  weightUnit: text("weight_unit"),

  // Inventory
  stockQuantity: integer("stock_quantity").notNull().default(1),
  lotItemCount: integer("lot_item_count"),
  purchaseCost: real("purchase_cost"),
  purchaseCurrency: text("purchase_currency"),
  internalNotes: text("internal_notes"),

  // Pricing
  priceEur: real("price_eur").notNull(),
  priceUsd: real("price_usd"),
  minOfferPrice: real("min_offer_price"),

  // Media
  videoUrl: text("video_url"),

  // Shipping
  shippingProfile: text("shipping_profile"),
  shippingNote: text("shipping_note"),
  customsWarning: integer("customs_warning", { mode: "boolean" }).notNull().default(false),

  // SEO
  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  keywords: text("keywords"), // JSON-encoded string[]

  // Website options
  isFeatured: integer("is_featured", { mode: "boolean" }).notNull().default(false),
  allowMakeOffer: integer("allow_make_offer", { mode: "boolean" }).notNull().default(false),
  allowCashOnDelivery: integer("allow_cash_on_delivery", { mode: "boolean" })
    .notNull()
    .default(false),
  showInArchiveAfterSale: integer("show_in_archive_after_sale", { mode: "boolean" })
    .notNull()
    .default(false),

  // eBay marketplace data (Sprint 3 foundation — all optional)
  ebayTitle: text("ebay_title"),
  ebaySubtitle: text("ebay_subtitle"),
  ebayDescription: text("ebay_description"),
  ebayConditionDescription: text("ebay_condition_description"),
  ebayCategory: text("ebay_category"),
  ebayItemSpecifics: text("ebay_item_specifics"),
  ebayListingPriceEur: real("ebay_listing_price_eur"),
  ebayListingStatus: text("ebay_listing_status"),

  // Etsy marketplace data (Sprint 3 foundation — all optional)
  etsyTitle: text("etsy_title"),
  etsyDescription: text("etsy_description"),
  etsyTags: text("etsy_tags"), // JSON-encoded string[]
  etsyMaterials: text("etsy_materials"),
  etsyStyle: text("etsy_style"),
  etsyOccasion: text("etsy_occasion"),
  etsyListingPriceEur: real("etsy_listing_price_eur"),
  etsyListingStatus: text("etsy_listing_status"),

  // WooCommerce marketplace data (Sprint 3 foundation — all optional)
  wooProductName: text("woo_product_name"),
  wooShortDescription: text("woo_short_description"),
  wooLongDescription: text("woo_long_description"),
  wooSlug: text("woo_slug"),
  wooSeoTitle: text("woo_seo_title"),
  wooMetaDescription: text("woo_meta_description"),
  wooFocusKeyword: text("woo_focus_keyword"),
  wooListingPriceEur: real("woo_listing_price_eur"),
  wooListingStatus: text("woo_listing_status"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});


export const productErpMetadata = sqliteTable("product_erp_metadata", {
  productId: text("product_id").primaryKey(),
  noctellaId: text("noctella_id"),
  barcodeValue: text("barcode_value"),
  purchaseSource: text("purchase_source"),
  provenance: text("provenance"),
  previousOwner: text("previous_owner"),
  auctionHouse: text("auction_house"),
  invoiceReferenceNumber: text("invoice_reference_number"),
  storageLocationReference: text("storage_location_reference"),
  shippingCostEur: real("shipping_cost_eur"),
  packagingCostEur: real("packaging_cost_eur"),
  miscCostsEur: real("misc_costs_eur"),
  actualSalePriceEur: real("actual_sale_price_eur"),
  productWorkflowStatus: text("product_workflow_status"),
  photoStatus: text("photo_status"),
  authenticationStatus: text("authentication_status"),
  marketplacePreparationStatus: text("marketplace_preparation_status"),
  internalPriority: text("internal_priority"),
  operationalNotes: text("operational_notes"),
  depthValue: real("depth_value"),
  depthUnit: text("depth_unit"),
  diameterValue: real("diameter_value"),
  diameterUnit: text("diameter_unit"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [
  index("idx_product_erp_metadata_noctella").on(table.noctellaId),
  index("idx_product_erp_metadata_barcode").on(table.barcodeValue),
  index("idx_product_erp_metadata_location").on(table.storageLocationReference),
]);

export const erpCommandExecutions = sqliteTable("erp_command_executions", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  commandId: text("command_id").notNull(),
  requestId: text("request_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  commandType: text("command_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  status: text("status").notNull(),
  resultReference: text("result_reference"),
  requestChecksum: text("request_checksum").notNull(),
  safeResultMetadata: text("safe_result_metadata"),
  safeErrorCode: text("safe_error_code"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  completedAt: text("completed_at"),
}, (table) => [
  index("idx_erp_command_executions_client_key").on(table.clientId, table.idempotencyKey),
  index("idx_erp_command_executions_entity").on(table.entityType, table.entityId),
  index("idx_erp_command_executions_status").on(table.status, table.createdAt),
]);

export const productPhotos = sqliteTable("product_photos", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  url: text("url").notNull(),
  thumbnailUrl: text("thumbnail_url").notNull(),
  altText: text("alt_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [
  index("idx_product_photos_product").on(table.productId),
  index("idx_product_photos_product_sort").on(table.productId, table.sortOrder),
]);

export const productImages = sqliteTable("product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  url: text("url").notNull(),
  altText: text("alt_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/**
 * Sprint 3: AI listing drafts. Uses its own status column (ai_draft_status
 * values) — intentionally not ProductStatus, per Sprint 3 rules.
 */
export const aiListingDrafts = sqliteTable("ai_listing_drafts", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  status: text("status").notNull(),

  generatedTitle: text("generated_title"),
  generatedDescription: text("generated_description"),
  generatedStory: text("generated_story"),
  generatedConditionDescription: text("generated_condition_description"),

  suggestedCategoryId: text("suggested_category_id"),
  suggestedCollectionId: text("suggested_collection_id"),
  suggestedEurPrice: real("suggested_eur_price"),
  suggestedUsdPrice: real("suggested_usd_price"),
  suggestedMinimumOfferPrice: real("suggested_minimum_offer_price"),

  seoTitle: text("seo_title"),
  metaDescription: text("meta_description"),
  keywords: text("keywords"), // JSON-encoded string[]

  shippingNote: text("shipping_note"),
  customsWarning: integer("customs_warning", { mode: "boolean" }),

  aiConfidenceScore: real("ai_confidence_score"),
  aiModel: text("ai_model"),
  generationPromptVersion: text("generation_prompt_version"),

  rejectionReason: text("rejection_reason"),
  reviewedByAdminUserId: text("reviewed_by_admin_user_id"),
  reviewedAt: text("reviewed_at"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/** Sprint 4: minimal "Make an Offer" persistence. Never auto-accepted. */
export const offers = sqliteTable("offers", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  offeredAmount: real("offered_amount").notNull(),
  currency: text("currency").notNull(),
  message: text("message"),
  status: text("status").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});


/** Sprint 7A: order persistence foundation. No checkout creation, stock reservation, ERP, or invoices. */
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  orderDraftId: text("order_draft_id"),
  customerId: text("customer_id"),
  guestEmail: text("guest_email").notNull(),
  status: text("status").notNull(),
  paymentStatus: text("payment_status").notNull(),
  paymentProvider: text("payment_provider"),
  paymentReference: text("payment_reference"),
  subtotalAmount: real("subtotal_amount").notNull(),
  shippingAmount: real("shipping_amount").notNull().default(0),
  taxAmount: real("tax_amount").notNull().default(0),
  totalAmount: real("total_amount").notNull(),
  currency: text("currency").notNull(),
  billingAddress: text("billing_address").notNull(),
  shippingAddress: text("shipping_address").notNull(),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  productSku: text("product_sku").notNull(),
  productTitle: text("product_title").notNull(),
  productSlug: text("product_slug").notNull(),
  productType: text("product_type").notNull(),
  productImageUrl: text("product_image_url"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: real("unit_price").notNull(),
  totalPrice: real("total_price").notNull(),
  currency: text("currency").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

/** Sprint 8: immutable stock movement ledger for manual adjustments and order sales. */
export const stockMovements = sqliteTable("stock_movements", {
  id: text("id").primaryKey(),
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
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const marketplaceConnections = sqliteTable("marketplace_connections", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), accountLabel: text("account_label").notNull(), externalAccountId: text("external_account_id"), encryptedAccessToken: text("encrypted_access_token"), encryptedRefreshToken: text("encrypted_refresh_token"), tokenExpiresAt: text("token_expires_at"), scopes: text("scopes"), status: text("status").notNull(), lastError: text("last_error"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_marketplace_connections_channel").on(table.channel)]);
export const publishJobs = sqliteTable("publish_jobs", {
  id: text("id").primaryKey(), productId: text("product_id").notNull(), channel: text("channel").notNull(), status: text("status").notNull(), idempotencyKey: text("idempotency_key").notNull().unique(), payloadSnapshot: text("payload_snapshot").notNull(), externalListingId: text("external_listing_id"), externalListingUrl: text("external_listing_url"), attemptCount: integer("attempt_count").notNull().default(0), lastError: text("last_error"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), completedAt: text("completed_at"),
}, (table) => [index("idx_publish_jobs_product").on(table.productId), index("idx_publish_jobs_channel").on(table.channel), index("idx_publish_jobs_status").on(table.status)]);
export const publishAttempts = sqliteTable("publish_attempts", {
  id: text("id").primaryKey(), publishJobId: text("publish_job_id").notNull(), attemptNumber: integer("attempt_number").notNull(), requestSnapshot: text("request_snapshot").notNull(), responseSnapshot: text("response_snapshot"), errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_publish_attempts_job").on(table.publishJobId)]);
export const externalListings = sqliteTable("external_listings", {
  id: text("id").primaryKey(), productId: text("product_id").notNull(), channel: text("channel").notNull(), connectionId: text("connection_id").notNull(), externalListingId: text("external_listing_id").notNull(), externalListingUrl: text("external_listing_url"), externalStatus: text("external_status").notNull(), payloadSnapshot: text("payload_snapshot").notNull(), publishedAt: text("published_at").notNull(), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_external_listings_product").on(table.productId), index("idx_external_listings_channel").on(table.channel), index("idx_external_listings_connection").on(table.connectionId)]);


export const marketplaceWebhookEvents = sqliteTable("marketplace_webhook_events", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), externalEventId: text("external_event_id").notNull(), eventType: text("event_type").notNull(), status: text("status").notNull(), signatureValid: integer("signature_valid", { mode: "boolean" }).notNull().default(false), payloadSnapshot: text("payload_snapshot").notNull(), attemptCount: integer("attempt_count").notNull().default(0), lastError: text("last_error"), receivedAt: text("received_at").notNull(), processedAt: text("processed_at"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_webhook_channel_status").on(table.channel, table.status), index("idx_webhook_received").on(table.receivedAt)]);
export const marketplaceOrders = sqliteTable("marketplace_orders", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), externalOrderId: text("external_order_id").notNull(), externalOrderNumber: text("external_order_number"), marketplaceConnectionId: text("marketplace_connection_id").notNull(), internalOrderId: text("internal_order_id"), status: text("status").notNull(), importStatus: text("import_status").notNull().default("pending"), attemptCount: integer("attempt_count").notNull().default(0), lastError: text("last_error"), lastErrorType: text("last_error_type"), retryable: integer("retryable", { mode: "boolean" }).notNull().default(true), currency: text("currency").notNull(), subtotal: real("subtotal").notNull(), shipping: real("shipping").notNull().default(0), tax: real("tax").notNull().default(0), total: real("total").notNull(), buyerEmail: text("buyer_email"), buyerName: text("buyer_name"), shippingAddressSnapshot: text("shipping_address_snapshot"), billingAddressSnapshot: text("billing_address_snapshot"), rawPayloadSnapshot: text("raw_payload_snapshot").notNull(), orderedAt: text("ordered_at").notNull(), importedAt: text("imported_at").notNull(), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_marketplace_orders_channel_status").on(table.channel, table.status), index("idx_marketplace_orders_connection").on(table.marketplaceConnectionId), index("idx_marketplace_orders_ordered").on(table.orderedAt)]);
export const marketplaceOrderItems = sqliteTable("marketplace_order_items", {
  id: text("id").primaryKey(), marketplaceOrderId: text("marketplace_order_id").notNull(), externalOrderItemId: text("external_order_item_id"), externalListingId: text("external_listing_id"), productId: text("product_id"), sku: text("sku"), titleSnapshot: text("title_snapshot").notNull(), quantity: integer("quantity").notNull(), unitPrice: real("unit_price").notNull(), lineTotal: real("line_total").notNull(), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_marketplace_items_order").on(table.marketplaceOrderId), index("idx_marketplace_items_product").on(table.productId)]);
export const marketplaceSyncRuns = sqliteTable("marketplace_sync_runs", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), syncType: text("sync_type").notNull(), status: text("status").notNull(), startedAt: text("started_at").notNull(), completedAt: text("completed_at"), processedCount: integer("processed_count").notNull().default(0), successCount: integer("success_count").notNull().default(0), failureCount: integer("failure_count").notNull().default(0), lastError: text("last_error"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_sync_runs_channel_status").on(table.channel, table.status), index("idx_sync_runs_started").on(table.startedAt)]);

export const marketplaceImportAttempts = sqliteTable("marketplace_import_attempts", {
  id: text("id").primaryKey(), marketplaceOrderId: text("marketplace_order_id").notNull(), attemptNumber: integer("attempt_number").notNull(), status: text("status").notNull(), errorType: text("error_type"), errorMessage: text("error_message"), retryable: integer("retryable", { mode: "boolean" }).notNull().default(false), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_marketplace_import_attempts_order").on(table.marketplaceOrderId)]);

export const backgroundJobs = sqliteTable("background_jobs", {
  id: text("id").primaryKey(), type: text("type").notNull(), status: text("status").notNull(), channel: text("channel"), productId: text("product_id"), externalListingId: text("external_listing_id"), payloadSnapshot: text("payload_snapshot").notNull(), idempotencyKey: text("idempotency_key").notNull().unique(), priority: integer("priority").notNull().default(0), attemptCount: integer("attempt_count").notNull().default(0), maxAttempts: integer("max_attempts").notNull().default(5), runAfter: text("run_after").notNull(), lockedAt: text("locked_at"), lockedBy: text("locked_by"), lastError: text("last_error"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), completedAt: text("completed_at"),
}, (table) => [index("idx_background_jobs_status_run").on(table.status, table.runAfter, table.priority), index("idx_background_jobs_type").on(table.type), index("idx_background_jobs_channel").on(table.channel), index("idx_background_jobs_product").on(table.productId), index("idx_background_jobs_external_listing").on(table.externalListingId)]);
export const marketplaceInventorySnapshots = sqliteTable("marketplace_inventory_snapshots", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), productId: text("product_id").notNull(), externalListingId: text("external_listing_id").notNull(), localStock: integer("local_stock").notNull(), marketplaceStock: integer("marketplace_stock").notNull(), capturedAt: text("captured_at").notNull(), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_inventory_snapshots_listing").on(table.channel, table.externalListingId, table.capturedAt), index("idx_inventory_snapshots_product").on(table.productId, table.capturedAt)]);
export const stockSyncConflicts = sqliteTable("stock_sync_conflicts", {
  id: text("id").primaryKey(), channel: text("channel").notNull(), productId: text("product_id"), externalListingId: text("external_listing_id"), conflictType: text("conflict_type").notNull(), status: text("status").notNull(), localStock: integer("local_stock"), marketplaceStock: integer("marketplace_stock"), detailsSnapshot: text("details_snapshot"), resolution: text("resolution"), detectedAt: text("detected_at").notNull(), resolvedAt: text("resolved_at"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_stock_sync_conflicts_open").on(table.status, table.channel, table.productId), index("idx_stock_sync_conflicts_listing").on(table.externalListingId)]);
export const stockSyncAudit = sqliteTable("stock_sync_audit", {
  id: text("id").primaryKey(), jobId: text("job_id"), channel: text("channel").notNull(), productId: text("product_id").notNull(), externalListingId: text("external_listing_id"), previousMarketplaceStock: integer("previous_marketplace_stock"), requestedMarketplaceStock: integer("requested_marketplace_stock").notNull(), confirmedMarketplaceStock: integer("confirmed_marketplace_stock"), resultStatus: text("result_status").notNull(), errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_stock_sync_audit_job").on(table.jobId), index("idx_stock_sync_audit_listing").on(table.channel, table.externalListingId, table.createdAt)]);

export const shipments = sqliteTable("shipments", {
  id: text("id").primaryKey(), orderId: text("order_id").notNull(), marketplaceOrderId: text("marketplace_order_id"), channel: text("channel"), carrierCode: text("carrier_code").notNull(), customCarrierName: text("custom_carrier_name"), trackingNumber: text("tracking_number"), trackingUrl: text("tracking_url"), status: text("status").notNull(), shippingCost: real("shipping_cost").notNull().default(0), currency: text("currency").notNull().default("EUR"), shippedAt: text("shipped_at"), deliveredAt: text("delivered_at"), cancelledAt: text("cancelled_at"), returnedAt: text("returned_at"), externalFulfillmentId: text("external_fulfillment_id"), marketplaceFulfillmentStatus: text("marketplace_fulfillment_status"), lastError: text("last_error"), customsSnapshot: text("customs_snapshot"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_shipments_order").on(table.orderId), index("idx_shipments_status").on(table.status), index("idx_shipments_tracking").on(table.trackingNumber), index("idx_shipments_channel").on(table.channel), index("idx_shipments_carrier").on(table.carrierCode)]);
export const shipmentItems = sqliteTable("shipment_items", { id: text("id").primaryKey(), shipmentId: text("shipment_id").notNull(), orderItemId: text("order_item_id").notNull(), quantity: integer("quantity").notNull(), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_shipment_items_shipment").on(table.shipmentId)]);
export const shipmentEvents = sqliteTable("shipment_events", { id: text("id").primaryKey(), shipmentId: text("shipment_id").notNull(), eventType: text("event_type").notNull(), previousStatus: text("previous_status"), newStatus: text("new_status"), payloadSnapshot: text("payload_snapshot"), errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_shipment_events_shipment").on(table.shipmentId, table.createdAt)]);
export const shipmentTrackingUpdates = sqliteTable("shipment_tracking_updates", { id: text("id").primaryKey(), shipmentId: text("shipment_id").notNull(), source: text("source").notNull(), externalStatus: text("external_status"), normalizedStatus: text("normalized_status"), location: text("location"), description: text("description"), occurredAt: text("occurred_at"), payloadSnapshot: text("payload_snapshot"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_tracking_shipment").on(table.shipmentId, table.createdAt)]);
export const saleFinancials = sqliteTable("sale_financials", { id: text("id").primaryKey(), orderId: text("order_id").notNull().unique(), grossRevenue: real("gross_revenue").notNull(), shippingCharged: real("shipping_charged").notNull(), shippingCost: real("shipping_cost").notNull(), marketplaceFee: real("marketplace_fee"), promotedFee: real("promoted_fee"), paymentFee: real("payment_fee"), taxVat: real("tax_vat").notNull().default(0), itemCost: real("item_cost").notNull(), netRevenue: real("net_revenue").notNull(), profit: real("profit").notNull(), currency: text("currency").notNull().default("EUR"), sourceSnapshot: text("source_snapshot").notNull(), completedAt: text("completed_at").notNull(), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) });

export const returnRequests = sqliteTable("return_requests", { id: text("id").primaryKey(), orderId: text("order_id").notNull(), marketplaceOrderId: text("marketplace_order_id"), shipmentId: text("shipment_id"), channel: text("channel"), externalReturnId: text("external_return_id"), externalReturnNumber: text("external_return_number"), status: text("status").notNull(), reason: text("reason").notNull(), reasonDetails: text("reason_details"), requestedResolution: text("requested_resolution").notNull(), approvedResolution: text("approved_resolution"), buyerMessage: text("buyer_message"), internalNote: text("internal_note"), requestedAt: text("requested_at").notNull(), authorizedAt: text("authorized_at"), receivedAt: text("received_at"), inspectedAt: text("inspected_at"), completedAt: text("completed_at"), cancelledAt: text("cancelled_at"), returnCarrierCode: text("return_carrier_code"), returnTrackingNumber: text("return_tracking_number"), returnTrackingUrl: text("return_tracking_url"), buyerShippedAt: text("buyer_shipped_at"), lastError: text("last_error"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_return_requests_order").on(table.orderId), index("idx_return_requests_status").on(table.status), index("idx_return_requests_channel").on(table.channel), index("idx_return_requests_external").on(table.channel, table.externalReturnId), index("idx_return_requests_dates").on(table.requestedAt, table.completedAt)]);
export const returnItems = sqliteTable("return_items", { id: text("id").primaryKey(), returnRequestId: text("return_request_id").notNull(), orderItemId: text("order_item_id").notNull(), productId: text("product_id"), quantityRequested: integer("quantity_requested").notNull(), quantityApproved: integer("quantity_approved"), quantityReceived: integer("quantity_received"), condition: text("condition"), stockDisposition: text("stock_disposition"), inspectionNote: text("inspection_note"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_return_items_request").on(table.returnRequestId), index("idx_return_items_order_item").on(table.orderItemId)]);
export const returnEvents = sqliteTable("return_events", { id: text("id").primaryKey(), returnRequestId: text("return_request_id").notNull(), eventType: text("event_type").notNull(), previousStatus: text("previous_status"), newStatus: text("new_status"), payloadSnapshot: text("payload_snapshot"), errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_return_events_request").on(table.returnRequestId, table.createdAt)]);
export const refunds = sqliteTable("refunds", { id: text("id").primaryKey(), orderId: text("order_id").notNull(), returnRequestId: text("return_request_id"), channel: text("channel"), externalRefundId: text("external_refund_id"), type: text("type").notNull(), status: text("status").notNull(), currency: text("currency").notNull().default("EUR"), subtotalAmount: real("subtotal_amount").notNull(), shippingAmount: real("shipping_amount").notNull().default(0), taxAmount: real("tax_amount").notNull().default(0), marketplaceFeeAdjustment: real("marketplace_fee_adjustment"), paymentFeeAdjustment: real("payment_fee_adjustment"), totalAmount: real("total_amount").notNull(), reason: text("reason"), idempotencyKey: text("idempotency_key").notNull().unique(), submittedAt: text("submitted_at"), succeededAt: text("succeeded_at"), failedAt: text("failed_at"), lastError: text("last_error"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_refunds_order").on(table.orderId), index("idx_refunds_return").on(table.returnRequestId), index("idx_refunds_status").on(table.status), index("idx_refunds_channel").on(table.channel), index("idx_refunds_external").on(table.channel, table.externalRefundId), index("idx_refunds_created").on(table.createdAt)]);
export const refundAllocations = sqliteTable("refund_allocations", { id: text("id").primaryKey(), refundId: text("refund_id").notNull(), orderItemId: text("order_item_id"), returnItemId: text("return_item_id"), quantity: integer("quantity"), amount: real("amount").notNull(), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_refund_allocations_refund").on(table.refundId)]);
export const saleReversals = sqliteTable("sale_reversals", { id: text("id").primaryKey(), orderId: text("order_id").notNull(), returnRequestId: text("return_request_id"), refundId: text("refund_id"), reversalType: text("reversal_type").notNull(), stockReversed: integer("stock_reversed", { mode: "boolean" }).notNull().default(false), financialsReversed: integer("financials_reversed", { mode: "boolean" }).notNull().default(false), originalSaleFinancialId: text("original_sale_financial_id"), sourceSnapshot: text("source_snapshot").notNull(), idempotencyKey: text("idempotency_key").notNull().unique(), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_sale_reversals_order").on(table.orderId), index("idx_sale_reversals_return").on(table.returnRequestId)]);

export const refundAttempts = sqliteTable("refund_attempts", { id: text("id").primaryKey(), refundId: text("refund_id").notNull(), attemptNumber: integer("attempt_number").notNull(), channel: text("channel"), status: text("status").notNull(), externalRefundId: text("external_refund_id"), requestSnapshot: text("request_snapshot").notNull(), responseSnapshot: text("response_snapshot"), errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`) }, (table) => [index("idx_refund_attempts_refund").on(table.refundId), index("idx_refund_attempts_status").on(table.status)]);

export const erpIntegrationClients = sqliteTable("erp_integration_clients", {
  id: text("id").primaryKey(), name: text("name").notNull(), keyHash: text("key_hash").notNull(), keyVersion: text("key_version").notNull(), isActive: integer("is_active", { mode: "boolean" }).notNull().default(true), lastSeenAt: text("last_seen_at"), lastClientVersion: text("last_client_version"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`), updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_erp_clients_active").on(table.isActive), index("idx_erp_clients_key_version").on(table.keyVersion)]);
export const erpIntegrationAudit = sqliteTable("erp_integration_audit", {
  id: text("id").primaryKey(), clientId: text("client_id"), requestId: text("request_id"), action: text("action").notNull(), entityType: text("entity_type"), entityId: text("entity_id"), result: text("result").notNull(), safeMetadata: text("safe_metadata"), errorCode: text("error_code"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_erp_audit_client").on(table.clientId), index("idx_erp_audit_request").on(table.requestId), index("idx_erp_audit_created").on(table.createdAt)]);
export const erpSyncCheckpoints = sqliteTable("erp_sync_checkpoints", {
  id: text("id").primaryKey(), clientId: text("client_id").notNull(), requestId: text("request_id"), checkpointToken: text("checkpoint_token").notNull(), acknowledgedAt: text("acknowledged_at").notNull(), safeMetadata: text("safe_metadata"), createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
}, (table) => [index("idx_erp_checkpoints_client").on(table.clientId), index("idx_erp_checkpoints_token").on(table.checkpointToken), index("idx_erp_checkpoints_request").on(table.requestId)]);
