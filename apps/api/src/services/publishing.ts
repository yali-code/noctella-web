import { ListingStatus, ProductStatus, PublishChannel, type Product, type ProductImage, type PublishPayload, type PublishPreview, type PublishValidation, type PublishValidationIssue } from "@noctella/shared";
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

function channelStatus(product: Product, channel: PublishChannel): ListingStatus {
  if (channel === PublishChannel.Ebay) return product.ebayListingStatus ?? ListingStatus.Draft;
  if (channel === PublishChannel.Etsy) return product.etsyListingStatus ?? ListingStatus.Draft;
  return product.wooListingStatus ?? ListingStatus.Draft;
}

export function validatePublish(product: Product, channel: PublishChannel): PublishValidation {
  const errors: PublishValidationIssue[] = [];
  const warnings: PublishValidationIssue[] = [];

  if (product.status === ProductStatus.Archived) errors.push(issue("invalid_listing_status", "error", "Archived products cannot be published", "status"));
  if (product.stockQuantity < 1) errors.push(issue("inventory_unavailable", "error", "Product must have stock available", "stockQuantity"));
  if (product.priceEur <= 0) errors.push(issue("price_missing", "error", "Base EUR price must be greater than 0", "priceEur"));
  if (blank(product.conditionDescription)) warnings.push(issue("content_warning", "warning", "Condition description is recommended", "conditionDescription"));

  if (channel === PublishChannel.Ebay) {
    required(product, [["ebayTitle", "eBay title"], ["ebayDescription", "eBay description"], ["ebayCategory", "eBay category"], ["ebayListingPriceEur", "eBay listing price"]], errors);
  } else if (channel === PublishChannel.Etsy) {
    required(product, [["etsyTitle", "Etsy title"], ["etsyDescription", "Etsy description"], ["etsyTags", "Etsy tags"], ["etsyListingPriceEur", "Etsy listing price"]], errors);
  } else {
    required(product, [["wooProductName", "Noctella Web product name"], ["wooShortDescription", "Noctella Web short description"], ["wooLongDescription", "Noctella Web long description"], ["wooListingPriceEur", "Noctella Web listing price"]], errors);
  }

  return { productId: product.id, channel, valid: errors.length === 0, errors, warnings };
}

export function buildPublishPayload(product: Product, images: ProductImage[], channel: PublishChannel): PublishPayload {
  if (channel === PublishChannel.Ebay) {
    return { productId: product.id, channel, listingStatus: channelStatus(product, channel), title: product.ebayTitle ?? product.title, description: product.ebayDescription ?? product.description ?? "", priceEur: product.ebayListingPriceEur ?? product.priceEur, category: product.ebayCategory, images, metadata: { subtitle: product.ebaySubtitle, itemSpecifics: product.ebayItemSpecifics, conditionDescription: product.ebayConditionDescription } };
  }
  if (channel === PublishChannel.Etsy) {
    return { productId: product.id, channel, listingStatus: channelStatus(product, channel), title: product.etsyTitle ?? product.title, description: product.etsyDescription ?? product.description ?? "", priceEur: product.etsyListingPriceEur ?? product.priceEur, images, metadata: { tags: product.etsyTags, materials: product.etsyMaterials, style: product.etsyStyle, occasion: product.etsyOccasion } };
  }
  return { productId: product.id, channel, listingStatus: channelStatus(product, channel), title: product.wooProductName ?? product.title, description: product.wooLongDescription ?? product.description ?? "", priceEur: product.wooListingPriceEur ?? product.priceEur, images, metadata: { shortDescription: product.wooShortDescription, slug: product.wooSlug, seoTitle: product.wooSeoTitle, metaDescription: product.wooMetaDescription, focusKeyword: product.wooFocusKeyword } };
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
