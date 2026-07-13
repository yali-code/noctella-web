import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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


/** Sprint 8A: stock movement ledger. Product stock updates happen only via the stock movement service. */
export const stockMovements = sqliteTable("stock_movements", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  type: text("type").notNull(),
  quantity: integer("quantity").notNull(),
  previousStock: integer("previous_stock").notNull(),
  newStock: integer("new_stock").notNull(),
  unitCost: real("unit_cost"),
  currency: text("currency"),
  referenceType: text("reference_type"),
  referenceId: text("reference_id"),
  note: text("note"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});
