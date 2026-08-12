import {
  DIMENSION_UNIT_VALUES,
  LISTING_STATUS_VALUES,
  PRICE_CURRENCY_VALUES,
  PRODUCT_SHIPPING_PROFILE_VALUES,
  PRODUCT_STATUS_VALUES,
  PRODUCT_TYPE_VALUES,
  ProductStatus,
  ProductType,
  WEIGHT_UNIT_VALUES,
} from "@noctella/shared";
import { z } from "zod";

const imageSchema = z.object({
  url: z.string().min(1, "Image URL is required"),
  altText: z.string().optional(),
  sortOrder: z.number().int().min(0).default(0),
  isPrimary: z.boolean().default(false),
});

/**
 * Base field set shared by create/update. Business rules that depend on
 * *type* (Unique Item vs Lot Item) are enforced separately in
 * services/products.ts, since they interact with defaults that zod alone
 * can't express cleanly.
 */
export const baseProductSchema = z.object({
  sku: z.string().min(1, "SKU is required"),
  title: z.string().min(1, "Title is required"),
  slug: z.string().min(1).optional(),
  type: z.enum(PRODUCT_TYPE_VALUES as [ProductType, ...ProductType[]]),
  status: z.enum(PRODUCT_STATUS_VALUES as [string, ...string[]]),
  categoryId: z.string().min(1, "Category is required"),
  collectionId: z.string().min(1).optional(),

  brand: z.string().optional(),
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  period: z.string().optional(),
  materials: z.string().optional(),
  description: z.string().optional(),
  productStory: z.string().optional(),
  condition: z.string().optional(),
  conditionDescription: z.string().optional(),

  lengthValue: z.number().min(0, "Length must be non-negative").optional(),
  widthValue: z.number().min(0, "Width must be non-negative").optional(),
  heightValue: z.number().min(0, "Height must be non-negative").optional(),
  dimensionUnit: z.enum(DIMENSION_UNIT_VALUES as [string, ...string[]]).optional(),
  weightValue: z.number().min(0, "Weight must be non-negative").optional(),
  weightUnit: z.enum(WEIGHT_UNIT_VALUES as [string, ...string[]]).optional(),

  stockQuantity: z.number().int().min(0, "Stock quantity cannot be negative").optional(),
  lotItemCount: z.number().int().min(1).optional(),
  purchaseCost: z.number().min(0, "Purchase cost cannot be negative").optional(),
  purchaseCurrency: z.enum(PRICE_CURRENCY_VALUES as [string, ...string[]]).optional(),
  internalNotes: z.string().optional(),

  /**
   * Sprint 137: optional/nullable - a Draft/Approved Product may not yet have a sale price (see
   * Product.priceEur's own doc comment in @noctella/shared). When a value IS supplied it must
   * still be a genuine positive EUR amount; createProductSchema's own superRefine below (and
   * services/products.ts's updateProduct) separately enforce that a Published Product can never
   * end up with no valid effective price - this field-level rule alone intentionally does not
   * encode that status-dependent requirement.
   */
  priceEur: z.number().positive("EUR price must be greater than 0").nullable().optional(),
  priceUsd: z.number().positive("USD price must be greater than 0").optional(),
  minOfferPrice: z.number().min(0, "Minimum offer price cannot be negative").optional(),

  videoUrl: z.string().optional(),

  /** Sprint 134: activates the previously-inert free-text placeholder as a controlled eligibility-classification vocabulary consumed by shipping-method resolution; unset/null is treated as Standard. */
  shippingProfile: z.enum(PRODUCT_SHIPPING_PROFILE_VALUES as [string, ...string[]]).optional(),
  shippingNote: z.string().optional(),
  customsWarning: z.boolean().optional(),

  seoTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  keywords: z.array(z.string()).optional(),

  isFeatured: z.boolean().optional(),
  allowMakeOffer: z.boolean().optional(),
  allowCashOnDelivery: z.boolean().optional(),
  showInArchiveAfterSale: z.boolean().optional(),

  images: z.array(imageSchema).optional(),

  // Sprint 3: marketplace data foundation — all optional at creation time.
  // Marketplace validation (readiness) happens only at future publish time.
  ebayTitle: z.string().optional(),
  ebaySubtitle: z.string().optional(),
  ebayDescription: z.string().optional(),
  ebayConditionDescription: z.string().optional(),
  ebayCategory: z.string().optional(),
  ebayItemSpecifics: z.string().optional(),
  ebayListingPriceEur: z.number().positive("eBay listing price must be greater than 0").optional(),
  ebayListingStatus: z.enum(LISTING_STATUS_VALUES as [string, ...string[]]).optional(),

  etsyTitle: z.string().optional(),
  etsyDescription: z.string().optional(),
  etsyTags: z.array(z.string()).optional(),
  etsyMaterials: z.string().optional(),
  etsyStyle: z.string().optional(),
  etsyOccasion: z.string().optional(),
  etsyListingPriceEur: z.number().positive("Etsy listing price must be greater than 0").optional(),
  etsyListingStatus: z.enum(LISTING_STATUS_VALUES as [string, ...string[]]).optional(),

  wooProductName: z.string().optional(),
  wooShortDescription: z.string().optional(),
  wooLongDescription: z.string().optional(),
  wooSlug: z.string().optional(),
  wooSeoTitle: z.string().optional(),
  wooMetaDescription: z.string().optional(),
  wooFocusKeyword: z.string().optional(),
  wooListingPriceEur: z.number().positive("WooCommerce listing price must be greater than 0").optional(),
  wooListingStatus: z.enum(LISTING_STATUS_VALUES as [string, ...string[]]).optional(),
});

/**
 * Sprint 137: a direct Product creation request must never be allowed to create a Published
 * Product with no valid effective price - this is deliberately a narrow, base-priceEur-only
 * safety net at the create boundary (the full channel-aware effective-price gate is
 * services/publishing.ts's validatePublish, invoked by the real publish routes; this only stops
 * an obviously-broken row from being created directly with status already set to Published).
 */
function hasValidPositivePrice(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export const createProductSchema = baseProductSchema.superRefine((data, ctx) => {
  const primaryCount = (data.images ?? []).filter((img) => img.isPrimary).length;
  if (primaryCount > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["images"],
      message: "Only one primary image is allowed",
    });
  }
  if (data.type === ProductType.UniqueItem && (data.stockQuantity ?? 1) > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["stockQuantity"],
      message: "Unique Item stock quantity cannot exceed 1",
    });
  }
  if (data.status === ProductStatus.Published && !hasValidPositivePrice(data.priceEur ?? undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["priceEur"],
      message: "A valid positive EUR price is required to create a Published product",
    });
  }
});

/**
 * Sprint 88: shared so the HTTP request schema (which additionally requires
 * expectedUpdatedAt) never re-implements these business rules - both schemas
 * refine the same partial(baseProductSchema) shape through this one function.
 */
function refineUpdateProductFields(data: Partial<z.infer<typeof baseProductSchema>>, ctx: z.RefinementCtx) {
  const primaryCount = (data.images ?? []).filter((img) => img.isPrimary).length;
  if (primaryCount > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["images"],
      message: "Only one primary image is allowed",
    });
  }
  if (data.type === ProductType.UniqueItem && data.stockQuantity !== undefined && data.stockQuantity > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["stockQuantity"],
      message: "Unique Item stock quantity cannot exceed 1",
    });
  }
}

/** Internal/command shape: editable Product fields only, no version token. */
export const updateProductSchema = baseProductSchema.partial().superRefine(refineUpdateProductFields);

/**
 * Sprint 88: HTTP request shape for PUT /api/products/:id - the same editable
 * fields as updateProductSchema plus a required expectedUpdatedAt. Built by
 * re-applying the shared refinement to base.partial().extend(...) rather than
 * calling .extend() on the already-refined updateProductSchema, since a
 * ZodEffects (the result of .superRefine()) does not safely expose .extend().
 */
export const updateProductRequestSchema = baseProductSchema
  .partial()
  .extend({ expectedUpdatedAt: z.string().min(1, "expectedUpdatedAt is required") })
  .superRefine(refineUpdateProductFields);

export const productListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(PRODUCT_STATUS_VALUES as [string, ...string[]]).optional(),
  type: z.enum(PRODUCT_TYPE_VALUES as [ProductType, ...ProductType[]]).optional(),
  categoryId: z.string().optional(),
  collectionId: z.string().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
/** Internal/command input: editable Product fields, no version token required. */
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
/**
 * Sprint 88: Product update command input - the internal shape plus an
 * optional caller-supplied expectedUpdatedAt. Trusted internal callers
 * (marketplacePublishing, etc.) may omit it and fall back to command-time
 * optimistic concurrency; the HTTP route always supplies one via
 * UpdateProductRequestInput below.
 */
export type UpdateProductCommandInput = UpdateProductInput & { expectedUpdatedAt?: string };
/** HTTP request input: editable Product fields with a required version token. */
export type UpdateProductRequestInput = z.infer<typeof updateProductRequestSchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
