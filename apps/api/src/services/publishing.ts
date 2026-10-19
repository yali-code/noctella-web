import { ETSY_LISTING_LIMITS, EtsyWhoMade, ListingStatus, parseEtsyWhenMade, ProductStatus, PublishChannel, type MarketplacePublishPayload, type Product, type ProductImage, type ProductPhoto, type PublishPreview, type PublishValidation, type PublishValidationIssue } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { getProductById } from "./products";
import { buildHistoricalPublishPayload } from "../integrations/productPublishingFoundation";
import { buildWooCommerceProductDraft } from "../integrations/woocommerce/productAdapter";

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

/**
 * Etsy listing form parity (Phase 1), enforced only here at the publish gate so incomplete drafts
 * always save. ERRORS are limited to requirements the Etsy listing API is known to enforce
 * (taxonomy, who/when made, shipping profile for physical items, title and tag limits) plus the
 * ERP's own inventory rule. Requirements seen in the Etsy web form but NOT yet verified against
 * Open API v3 are WARNINGS, so an unverified assumption can never block publishing; promote them
 * to errors only after Phase 4 verification. Nothing is inferred: missing seller facts stay missing.
 */
function validateEtsyListingForm(product: Product, errors: PublishValidationIssue[], warnings: PublishValidationIssue[]) {
  required(product, [
    ["etsyTaxonomyId", "Etsy category (taxonomy ID)"], ["etsyWhoMade", "Etsy 'Who made it?'"],
    ["etsyWhenMade", "Etsy 'When was it made?'"], ["etsyShippingProfileId", "Etsy shipping profile"],
  ], errors);
  for (const [field, label] of [["etsyIsSupply", "Etsy 'What is it?'"], ["etsyProcessingProfileId", "Etsy processing profile"], ["etsyReturnPolicyId", "Etsy return policy"]] as const) {
    if (blank(product[field])) warnings.push(issue("missing_required_field", "warning", `${label} is asked for by the Etsy listing form (API requirement to be verified)`, field));
  }
  const L = ETSY_LISTING_LIMITS;
  const limit = (field: string, message: string) => errors.push(issue("marketplace_limit_exceeded", "error", message, field));
  const unverifiedLimit = (field: string, message: string) => warnings.push(issue("marketplace_limit_exceeded", "warning", `${message} (limit to be verified against the Etsy API)`, field));
  if (product.etsyTitle && product.etsyTitle.length > L.titleMaxLength) limit("etsyTitle", `Etsy title must be at most ${L.titleMaxLength} characters`);
  const tags = product.etsyTags ?? [];
  if (tags.length > L.tagsMax) limit("etsyTags", `Etsy allows at most ${L.tagsMax} tags`);
  if (tags.some((tag) => tag.length > L.tagMaxLength)) limit("etsyTags", `Each Etsy tag must be at most ${L.tagMaxLength} characters`);
  const materials = (product.etsyMaterials ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (materials.length > L.materialsMax) unverifiedLimit("etsyMaterials", `Etsy allows at most ${L.materialsMax} materials (comma-separated)`);
  if (materials.some((m) => m.length > L.materialMaxLength)) unverifiedLimit("etsyMaterials", `Each Etsy material must be at most ${L.materialMaxLength} characters`);
  const sku = product.etsySku ?? product.sku;
  if (sku && sku.length > L.skuMaxLength) unverifiedLimit("etsySku", `Etsy SKU must be at most ${L.skuMaxLength} characters`);
  // Never offer more on Etsy than the ERP holds; the canonical inventory is not changed here.
  if (product.etsyQuantity != null && product.etsyQuantity > product.stockQuantity) {
    errors.push(issue("inventory_unavailable", "error", "Etsy quantity cannot exceed available ERP stock", "etsyQuantity"));
  }
  // Etsy marketplace policy: items made by someone else must be vintage (20+ years) or supplies.
  // A seller-policy check, not a verified API validation - warn, do not block.
  if (product.etsyWhoMade === EtsyWhoMade.SomeoneElse && product.etsyIsSupply === false && product.etsyWhenMade) {
    const span = parseEtsyWhenMade(product.etsyWhenMade);
    const latestVintageYear = new Date().getUTCFullYear() - L.vintageMinAgeYears;
    if (!span || span.toYear === null || span.toYear > latestVintageYear) {
      warnings.push(issue("invalid_marketplace_value", "warning", `Etsy policy: an item made by someone else must be vintage (made in or before ${latestVintageYear}) unless it is a supply`, "etsyWhenMade"));
    }
  }
  if (product.etsyAdsOptIn) warnings.push(issue("content_warning", "warning", "Etsy Ads is never enabled by the ERP; manage advertising in Etsy directly", "etsyAdsOptIn"));
  const manufacturer = [product.etsyGpsrManufacturerName, product.etsyGpsrManufacturerAddress, product.etsyGpsrManufacturerContact];
  const responsible = [product.etsyGpsrResponsiblePersonName, product.etsyGpsrResponsiblePersonAddress, product.etsyGpsrResponsiblePersonContact];
  if (manufacturer.every(blank)) warnings.push(issue("content_warning", "warning", "GPSR manufacturer information is not provided; add it if EU product-safety rules apply to this item (never inferred)", "etsyGpsrManufacturerName"));
  else if (manufacturer.some(blank)) warnings.push(issue("content_warning", "warning", "GPSR manufacturer information is incomplete (name, postal address and contact)", "etsyGpsrManufacturerName"));
  if (responsible.some((v) => !blank(v)) && responsible.some(blank)) warnings.push(issue("content_warning", "warning", "GPSR EU responsible person information is incomplete (name, postal address and contact)", "etsyGpsrResponsiblePersonName"));
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
    validateEtsyListingForm(product, errors, warnings);
  } else if (channel === PublishChannel.NoctellaWeb) {
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
export function buildPublishPayload(product: Product, images: ProductImage[], channel: PublishChannel): MarketplacePublishPayload {
  if (channel === PublishChannel.WooCommerce) return buildWooCommerceProductDraft(product, images as unknown as ProductPhoto[]);
  return buildHistoricalPublishPayload(product, images, channel);
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
