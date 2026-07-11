export interface PublicProductImage {
  id: string;
  url: string;
  altText?: string;
  sortOrder: number;
  isPrimary: boolean;
}

export interface PublicProduct {
  id: string;
  slug: string;
  title: string;
  type: string;
  description?: string;
  productStory?: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  period?: string;
  materials?: string;
  lengthValue?: number;
  widthValue?: number;
  heightValue?: number;
  dimensionUnit?: string;
  weightValue?: number;
  weightUnit?: string;
  condition?: string;
  conditionDescription?: string;
  priceEur: number;
  priceUsd?: number;
  videoUrl?: string;
  shippingNote?: string;
  customsWarning: boolean;
  isFeatured: boolean;
  allowMakeOffer: boolean;
  status: string;
  categoryId?: string;
  categoryName?: string;
  categorySlug?: string;
  collectionId?: string;
  collectionName?: string;
  collectionSlug?: string;
  seoTitle?: string;
  metaDescription?: string;
  images: PublicProductImage[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicProductDetail extends PublicProduct {
  relatedProducts: PublicProduct[];
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  displayImageUrl?: string;
  seoTitle?: string;
  metaDescription?: string;
}

export interface PublicCollection {
  id: string;
  name: string;
  slug: string;
  description?: string;
  coverImageUrl?: string;
  seoTitle?: string;
  metaDescription?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
