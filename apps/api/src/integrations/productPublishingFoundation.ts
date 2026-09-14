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
  historicalExecutionPayload?: PublishPayload;
}

/** Canonical preparation adapter consumed by the historical job/attempt/listing executor. */
export function buildHistoricalPublishPayload(product: Product, images: ProductImage[], channel: PublishChannel): PublishPayload {
  const target = channel === PublishChannel.Ebay ? "ebay" : channel === PublishChannel.Etsy ? "etsy" : "noctella_web";
  const prepared = buildProductPublicationEnvelope(product, images as unknown as ProductPhoto[], target).historicalExecutionPayload;
  if (!prepared) throw new Error(`Historical publishing is unsupported for target: ${target}`);
  return prepared;
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
  const images = photos as unknown as ProductImage[];
  if (target === "ebay") { const historicalExecutionPayload = { productId: product.id, channel: PublishChannel.Ebay, listingStatus: product.ebayListingStatus ?? ListingStatus.Draft, title: product.ebayTitle ?? product.title, description: product.ebayDescription ?? product.description ?? "", priceEur: (product.ebayListingPriceEur ?? product.priceEur)!, category: product.ebayCategory, images, metadata: { subtitle: product.ebaySubtitle, itemSpecifics: product.ebayItemSpecifics, conditionDescription: product.ebayConditionDescription } }; return { ...shared, payload: historicalExecutionPayload, historicalExecutionPayload }; }
  if (target === "etsy") { const historicalExecutionPayload = { productId: product.id, channel: PublishChannel.Etsy, listingStatus: product.etsyListingStatus ?? ListingStatus.Draft, title: product.etsyTitle ?? product.title, description: product.etsyDescription ?? product.description ?? "", priceEur: (product.etsyListingPriceEur ?? product.priceEur)!, images, metadata: { tags: product.etsyTags, materials: product.etsyMaterials, style: product.etsyStyle, occasion: product.etsyOccasion } }; return { ...shared, payload: historicalExecutionPayload, historicalExecutionPayload }; }
  const historicalExecutionPayload = { productId: product.id, channel: PublishChannel.NoctellaWeb, listingStatus: product.wooListingStatus ?? ListingStatus.Draft, title: product.wooProductName ?? product.title, description: product.wooLongDescription ?? product.description ?? "", priceEur: (product.wooListingPriceEur ?? product.priceEur)!, images, metadata: { shortDescription: product.wooShortDescription, slug: product.wooSlug, seoTitle: product.wooSeoTitle, metaDescription: product.wooMetaDescription, focusKeyword: product.wooFocusKeyword } };
  return { ...shared, payload: { productId: product.id, status: product.status }, historicalExecutionPayload };
}
