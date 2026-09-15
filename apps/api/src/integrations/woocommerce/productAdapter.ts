import type { Product, ProductPhoto, WooCommercePublishPayload } from "@noctella/shared";

export type WooCommerceProductDraft = WooCommercePublishPayload;

export function buildWooCommerceProductDraft(
  product: Product,
  photos: readonly ProductPhoto[] = [],
): WooCommerceProductDraft {
  const price = product.wooListingPriceEur ?? product.priceEur;
  return {
    sku: product.sku,
    name: product.wooProductName?.trim() || product.title,
    slug: product.wooSlug?.trim() || product.slug,
    type: "simple",
    ...(price === null || price === undefined ? {} : { regular_price: price.toFixed(2) }),
    description: product.wooLongDescription?.trim() || product.description?.trim() || "",
    short_description: product.wooShortDescription?.trim() || "",
    manage_stock: true,
    stock_quantity: product.stockQuantity,
    images: [...photos]
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || left.sortOrder - right.sortOrder)
      .map((photo) => ({ src: photo.url, alt: photo.altText?.trim() || product.title })),
    meta_data: [
      { key: "_noctella_product_id", value: product.id },
      { key: "_noctella_currency", value: "EUR" },
    ],
  };
}
