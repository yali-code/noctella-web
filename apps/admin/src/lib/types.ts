import type { Category, Collection, Product, ProductImage } from "@noctella/shared";

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
}

export type { Category, Collection };
