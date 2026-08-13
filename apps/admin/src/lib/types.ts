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

/**
 * Sprint 139: the Pending Publish queue's minimal row - deliberately not a ProductListItem.
 * stockAcceptedAt is the authoritative Warehouse Stock Acceptance timestamp
 * (ai_product_intakes.appliedAt), never Product createdAt/updatedAt.
 */
export interface PendingPublishItem {
  id: string;
  title: string;
  stockAcceptedAt: string;
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
