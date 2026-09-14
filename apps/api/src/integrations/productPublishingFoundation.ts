import type { Product, ProductPhoto } from "@noctella/shared";
import { buildWooCommerceProductDraft } from "./woocommerce/productAdapter";

export const PRODUCT_PUBLICATION_TARGETS = ["noctella_web", "ebay", "etsy", "woocommerce"] as const;
export type ProductPublicationTarget = (typeof PRODUCT_PUBLICATION_TARGETS)[number];

export interface ProductPublicationEnvelope {
  target: ProductPublicationTarget;
  sourceProductId: string;
  sourceUpdatedAt: string;
  inventory: Readonly<{ managedBy: "noctella"; quantity: number }>;
  currency: "EUR";
  payload: Readonly<Record<string, unknown>>;
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
