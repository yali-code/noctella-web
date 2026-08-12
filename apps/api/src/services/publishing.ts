import { ListingStatus, ProductStatus, PublishChannel, type Product, type ProductImage, type ProductPhoto, type PublishPayload, type PublishPreview, type PublishValidation, type PublishValidationIssue } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getProductById } from "./products";

function issue(type: PublishValidationIssue["type"], severity: PublishValidationIssue["severity"], message: string, field?: string): PublishValidationIssue {
  return { type, severity, message, field };
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function required(product: Product, fields: Array<[keyof Product, string]>, errors: PublishValidationIssue[]) {
  for (const [field, label] of fields) {
    if (blank(product[field])) errors.push(issue("missing_required_field", "error", `${label} is required`, String(field)));
  }
}

/**
 * Sprint 137: the channel-aware effective price - must stay in exact agreement with
 * buildPublishPayload's own per-channel `priceEur` line below, since validatePublish is the
 * authoritative gate that decides whether that payload is ever allowed to be built/used. Reusing
 * this same precedence here (rather than the old unconditional base-priceEur check) is the
 * precise, minimum correction required once Product.priceEur became nullable: a Product whose
 * base priceEur is null but whose channel-specific listing price is set must still be publishable
 * on that channel, exactly as "wooListingPriceEur ?? priceEur" (and the eBay/Etsy equivalents)
 * already promise.
 */
function effectivePriceEur(product: Product, channel: PublishChannel): number | null {
  if (channel === PublishChannel.Ebay) return product.ebayListingPriceEur ?? product.priceEur ?? null;
  if (channel === PublishChannel.Etsy) return product.etsyListingPriceEur ?? product.priceEur ?? null;
  return product.wooListingPriceEur ?? product.priceEur ?? null;
}

function channelStatus(product: Product, channel: PublishChannel): ListingStatus {
  if (channel === PublishChannel.Ebay) return product.ebayListingStatus ?? ListingStatus.Draft;
  if (channel === PublishChannel.Etsy) return product.etsyListingStatus ?? ListingStatus.Draft;
  return product.wooListingStatus ?? ListingStatus.Draft;
}

/**
 * Sprint 87: publish validation is an invariant gate, not a read-side resilience policy - unlike
 * the fallback-inclusive primary selection used by getPrimaryByProduct/listPubliclyVisibleByProduct
 * (product-read/drizzle.ts) and the OrderItem snapshot query (order/drizzle.ts), which deliberately
 * fall back to the best-available photo when no explicit Primary is set. Publishing must require an
 * explicitly marked isPrimary photo whose processingStatus is Ready or Processing (matching Sprint
 * 85's public-visibility policy and Sprint 86's snapshot-eligible statuses) - never a sortOrder/id
 * fallback, and never Failed.
 */
function hasEligiblePrimaryPhoto(photos: ProductPhoto[] | undefined): boolean {
  return (photos ?? []).some((photo) => photo.isPrimary === true && (photo.processingStatus === "Ready" || photo.processingStatus === "Processing"));
}

export function validatePublish(product: Product & { photos?: ProductPhoto[] }, channel: PublishChannel): PublishValidation {
  const errors: PublishValidationIssue[] = [];
  const warnings: PublishValidationIssue[] = [];

  if (product.status === ProductStatus.Archived) errors.push(issue("invalid_listing_status", "error", "Archived products cannot be published", "status"));
  if (product.stockQuantity < 1) errors.push(issue("inventory_unavailable", "error", "Product must have stock available", "stockQuantity"));
  const effectivePrice = effectivePriceEur(product, channel);
  if (effectivePrice == null || effectivePrice <= 0) errors.push(issue("price_missing", "error", "A valid positive EUR price is required before publishing", "priceEur"));
  if (!hasEligiblePrimaryPhoto(product.photos)) errors.push(issue("primary_product_photo_required", "error", "A Primary product photo is required before publishing.", "photos"));
  if (blank(product.conditionDescription)) warnings.push(issue("content_warning", "warning", "Condition description is recommended", "conditionDescription"));

  if (channel === PublishChannel.Ebay) {
    required(product, [["ebayTitle", "eBay title"], ["ebayDescription", "eBay description"], ["ebayCategory", "eBay category"], ["ebayListingPriceEur", "eBay listing price"]], errors);
  } else if (channel === PublishChannel.Etsy) {
    required(product, [["etsyTitle", "Etsy title"], ["etsyDescription", "Etsy description"], ["etsyTags", "Etsy tags"], ["etsyListingPriceEur", "Etsy listing price"]], errors);
  } else {
    // Sprint 137: wooListingPriceEur is deliberately NOT in this required list - it is an
    // optional per-channel override, not an independent requirement. The effectivePriceEur
    // check above already enforces "wooListingPriceEur ?? priceEur" is a valid positive amount,
    // which correctly accepts a valid base priceEur alone when no Noctella Web-specific
    // override has been set. eBay/Etsy intentionally keep their own separate, unchanged
    // required-listing-price checks below/above - this relaxation is Noctella Web-specific only.
    required(product, [["wooProductName", "Noctella Web product name"], ["wooShortDescription", "Noctella Web short description"], ["wooLongDescription", "Noctella Web long description"]], errors);
  }

  return { productId: product.id, channel, valid: errors.length === 0, errors, warnings };
}

/**
 * Sprint 137: buildPublishPayload is only ever called after validatePublish has already
 * confirmed `effectivePriceEur(product, channel)` is a valid positive number - once from
 * buildPublishPreview (gated by `validation.valid`), once from executePublish
 * (marketplacePublishing.ts, which throws BadRequestError on an invalid validation result before
 * ever reaching this call). The non-null assertion below trusts that already-enforced invariant
 * rather than re-deriving a fallback value here, matching PublishPayload.priceEur's own
 * intentionally-still-required (never nullable) type - a resolved payload must always carry a
 * real price.
 */
export function buildPublishPayload(product: Product, images: ProductImage[], channel: PublishChannel): PublishPayload {
  const priceEur = effectivePriceEur(product, channel)!;
  if (channel === PublishChannel.Ebay) {
    return { productId: product.id, channel, listingStatus: channelStatus(product, channel), title: product.ebayTitle ?? product.title, description: product.ebayDescription ?? product.description ?? "", priceEur, category: product.ebayCategory, images, metadata: { subtitle: product.ebaySubtitle, itemSpecifics: product.ebayItemSpecifics, conditionDescription: product.ebayConditionDescription } };
  }
  if (channel === PublishChannel.Etsy) {
    return { productId: product.id, channel, listingStatus: channelStatus(product, channel), title: product.etsyTitle ?? product.title, description: product.etsyDescription ?? product.description ?? "", priceEur, images, metadata: { tags: product.etsyTags, materials: product.etsyMaterials, style: product.etsyStyle, occasion: product.etsyOccasion } };
  }
  return { productId: product.id, channel, listingStatus: channelStatus(product, channel), title: product.wooProductName ?? product.title, description: product.wooLongDescription ?? product.description ?? "", priceEur, images, metadata: { shortDescription: product.wooShortDescription, slug: product.wooSlug, seoTitle: product.wooSeoTitle, metaDescription: product.wooMetaDescription, focusKeyword: product.wooFocusKeyword } };
}

export function buildPublishPreview(product: Product & { images: ProductImage[] }, channel: PublishChannel): PublishPreview {
  const validation = validatePublish(product, channel);
  return { productId: product.id, channel, validation, payload: validation.valid ? buildPublishPayload(product, product.images, channel) : undefined };
}

export async function getPublishPreview(db: DbClient, productId: string, channel: PublishChannel): Promise<PublishPreview> {
  return buildPublishPreview(await getProductById(db, productId), channel);
}

export async function getPublishValidation(db: DbClient, productId: string, channel: PublishChannel): Promise<PublishValidation> {
  return getPublishPreview(db, productId, channel).then((preview) => preview.validation);
}
