import type { Category, Collection, Product, ProductImage, ProductMarketplaceReadiness } from "@noctella/shared";

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
  images: ProductImage[];
  marketplaceReadiness: ProductMarketplaceReadiness;
}

export type { Category, Collection };
