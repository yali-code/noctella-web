import type {
  AiListingDraft,
  Category,
  Collection,
  Product,
  ProductImage,
  ProductPhoto,
  ProductMarketplaceReadiness,
} from "@noctella/shared";

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductListItem extends Product {
  primaryImageUrl?: string;
}

export interface ProductDetail extends Product {
  photos: ProductPhoto[];
  images: ProductImage[];
  marketplaceReadiness: ProductMarketplaceReadiness;
}

export interface AiDraftListItem extends AiListingDraft {
  productTitle: string;
  productSku: string;
  primaryImageUrl?: string;
}

export type { AiListingDraft, Category, Collection };
