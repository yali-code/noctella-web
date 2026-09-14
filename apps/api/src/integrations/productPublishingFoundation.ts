import { ListingStatus, PublishChannel, type Product, type ProductImage, type ProductPhoto, type PublishPayload } from "@noctella/shared";
import { buildWooCommerceProductDraft } from "./woocommerce/productAdapter";

export const PRODUCT_PUBLICATION_TARGETS = ["noctella_web", "ebay", "etsy", "woocommerce"] as const;
export type ProductPublicationTarget = (typeof PRODUCT_PUBLICATION_TARGETS)[number];
export const WOO_FIELD_OWNERSHIP = "noctella_web_defaults_for_woocommerce" as const;

export interface ProductPublicationEnvelope {
  target: ProductPublicationTarget;
  sourceProductId: string;
  sourceUpdatedAt: string;
  inventory: Readonly<{ managedBy: "noctella"; quantity: number }>;
  currency: "EUR";
  payload: Readonly<Record<string, unknown>>;
}

/** Canonical preparation adapter consumed by the historical job/attempt/listing executor. */
export function buildHistoricalPublishPayload(product: Product, images: ProductImage[], channel: PublishChannel): PublishPayload {
  if (channel === PublishChannel.Ebay) return { productId: product.id, channel, listingStatus: product.ebayListingStatus ?? ListingStatus.Draft, title: product.ebayTitle ?? product.title, description: product.ebayDescription ?? product.description ?? "", priceEur: (product.ebayListingPriceEur ?? product.priceEur)!, category: product.ebayCategory, images, metadata: { subtitle: product.ebaySubtitle, itemSpecifics: product.ebayItemSpecifics, conditionDescription: product.ebayConditionDescription } };
  if (channel === PublishChannel.Etsy) return { productId: product.id, channel, listingStatus: product.etsyListingStatus ?? ListingStatus.Draft, title: product.etsyTitle ?? product.title, description: product.etsyDescription ?? product.description ?? "", priceEur: (product.etsyListingPriceEur ?? product.priceEur)!, images, metadata: { tags: product.etsyTags, materials: product.etsyMaterials, style: product.etsyStyle, occasion: product.etsyOccasion } };
  return { productId: product.id, channel, listingStatus: product.wooListingStatus ?? ListingStatus.Draft, title: product.wooProductName ?? product.title, description: product.wooLongDescription ?? product.description ?? "", priceEur: (product.wooListingPriceEur ?? product.priceEur)!, images, metadata: { shortDescription: product.wooShortDescription, slug: product.wooSlug, seoTitle: product.wooSeoTitle, metaDescription: product.wooMetaDescription, focusKeyword: product.wooFocusKeyword } };
}

export function buildProductPublicationEnvelope(
  product: Product,
  photos: readonly ProductPhoto[],
  target: ProductPublicationTarget,
): ProductPublicationEnvelope {
  const shared = {
    target,
    sourceProductId: product.id,
    sourceUpdatedAt: product.updatedAt,
    inventory: { managedBy: "noctella" as const, quantity: product.stockQuantity },
    currency: "EUR" as const,
  };
  if (target === "woocommerce") return { ...shared, payload: buildWooCommerceProductDraft(product, photos) as unknown as Record<string, unknown> };
  if (target === "noctella_web") return { ...shared, payload: { productId: product.id, status: product.status } };
  if (target === "ebay") return { ...shared, payload: { sku: product.sku, title: product.ebayTitle ?? product.title, priceEur: product.ebayListingPriceEur ?? product.priceEur } };
  return { ...shared, payload: { sku: product.sku, title: product.etsyTitle ?? product.title, priceEur: product.etsyListingPriceEur ?? product.priceEur } };
}
