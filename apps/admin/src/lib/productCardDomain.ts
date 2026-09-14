import type { ProductMarketplaceReadiness, ProductPhoto } from "@noctella/shared";

export const PRODUCT_CARD_SECTIONS = [
  "identity",
  "commercial",
  "inventory",
  "content",
  "media",
  "publishing",
] as const;

export type ProductCardSection = (typeof PRODUCT_CARD_SECTIONS)[number];

export interface ProductCardSource {
  id: string;
  sku: string;
  title: string;
  slug: string;
  status: string;
  type: string;
  priceEur: number | null;
  stockQuantity: number;
  description?: string;
  photos: ProductPhoto[];
  marketplaceReadiness: ProductMarketplaceReadiness;
}

export interface ProductCardSummary {
  identity: Readonly<{ id: string; sku: string; title: string; slug: string }>;
  commercial: Readonly<{ currency: "EUR"; price: number | null }>;
  inventory: Readonly<{ quantity: number }>;
  content: Readonly<{ description: string | null }>;
  media: Readonly<{ primaryPhoto: ProductPhoto | null; photoCount: number }>;
  publishing: ProductMarketplaceReadiness;
  status: string;
  type: string;
}

export function buildProductCardSummary(product: ProductCardSource): ProductCardSummary {
  return {
    identity: { id: product.id, sku: product.sku, title: product.title, slug: product.slug },
    commercial: { currency: "EUR", price: product.priceEur },
    inventory: { quantity: product.stockQuantity },
    content: { description: product.description?.trim() || null },
    media: {
      primaryPhoto: product.photos.find((photo) => photo.isPrimary) ?? product.photos[0] ?? null,
      photoCount: product.photos.length,
    },
    publishing: product.marketplaceReadiness,
    status: product.status,
    type: product.type,
  };
}

export function formatEur(price: number | null): string {
  return price === null
    ? "No price set"
    : new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(price);
}
