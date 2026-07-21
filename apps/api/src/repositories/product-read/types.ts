export type ProductReadListQuery = { page?: number; pageSize?: number; limit?: number; offset?: number; search?: string; status?: string; type?: string; categoryId?: string; collectionId?: string; categorySlug?: string; collectionSlug?: string; published?: boolean; isFeatured?: boolean; updatedSince?: string; sort?: string };

type Nullable<T> = T | null;
export type ProductBaseReadProjection = {
  id: string; erpReferenceId: Nullable<string>; sku: string; title: string; slug: string; type: string; status: string;
  categoryId: Nullable<string>; collectionId: Nullable<string>; brand: Nullable<string>; model: Nullable<string>;
  manufacturer: Nullable<string>; countryOfOrigin: Nullable<string>; period: Nullable<string>; materials: Nullable<string>;
  description: Nullable<string>; productStory: Nullable<string>; condition: Nullable<string>; conditionDescription: Nullable<string>;
  lengthValue: Nullable<number>; widthValue: Nullable<number>; heightValue: Nullable<number>; dimensionUnit: Nullable<string>;
  weightValue: Nullable<number>; weightUnit: Nullable<string>; stockQuantity: number; lotItemCount: Nullable<number>;
  purchaseCost: Nullable<number>; purchaseCurrency: Nullable<string>; internalNotes: Nullable<string>; priceEur: number;
  priceUsd: Nullable<number>; minOfferPrice: Nullable<number>; videoUrl: Nullable<string>; shippingProfile: Nullable<string>;
  shippingNote: Nullable<string>; customsWarning: boolean; seoTitle: Nullable<string>; metaDescription: Nullable<string>;
  keywords: Nullable<string>; isFeatured: boolean; allowMakeOffer: boolean; allowCashOnDelivery: boolean; showInArchiveAfterSale: boolean;
  ebayTitle: Nullable<string>; ebaySubtitle: Nullable<string>; ebayDescription: Nullable<string>; ebayConditionDescription: Nullable<string>;
  ebayCategory: Nullable<string>; ebayItemSpecifics: Nullable<string>; ebayListingPriceEur: Nullable<number>; ebayListingStatus: Nullable<string>;
  etsyTitle: Nullable<string>; etsyDescription: Nullable<string>; etsyTags: Nullable<string>; etsyMaterials: Nullable<string>;
  etsyStyle: Nullable<string>; etsyOccasion: Nullable<string>; etsyListingPriceEur: Nullable<number>; etsyListingStatus: Nullable<string>;
  wooProductName: Nullable<string>; wooShortDescription: Nullable<string>; wooLongDescription: Nullable<string>; wooSlug: Nullable<string>;
  wooSeoTitle: Nullable<string>; wooMetaDescription: Nullable<string>; wooFocusKeyword: Nullable<string>; wooListingPriceEur: Nullable<number>;
  wooListingStatus: Nullable<string>; createdAt: string; updatedAt: string;
};
export type ProductListProjection = ProductBaseReadProjection & { primaryImageUrl?: string | null };
export type ProductDetailProjection = ProductBaseReadProjection;
export type ProductPublicProjection = Pick<ProductBaseReadProjection, "id"|"slug"|"title"|"type"|"status"|"description"|"productStory"|"brand"|"model"|"manufacturer"|"countryOfOrigin"|"period"|"materials"|"condition"|"conditionDescription"|"lengthValue"|"widthValue"|"heightValue"|"dimensionUnit"|"weightValue"|"weightUnit"|"priceEur"|"priceUsd"|"videoUrl"|"shippingNote"|"customsWarning"|"isFeatured"|"allowMakeOffer"|"allowCashOnDelivery"|"categoryId"|"collectionId"|"seoTitle"|"metaDescription"|"createdAt"|"updatedAt">;
export type ProductAdminProjection = ProductBaseReadProjection;
export type ProductErpProjection = Pick<ProductBaseReadProjection, "id"|"erpReferenceId"|"sku"|"title"|"status"|"categoryId"|"collectionId"|"brand"|"condition"|"lengthValue"|"widthValue"|"heightValue"|"dimensionUnit"|"weightValue"|"weightUnit"|"purchaseCost"|"priceEur"|"stockQuantity"|"updatedAt">;
export type ProductAvailabilityProjection = { productId: string; physicalStock: number; reservedStock: number; reservedStockSupported: boolean; availableStock: number; availableQuantity: number };
export type ProductWorkspaceReadProjection = ProductErpProjection;
export type ProductReadProjection = ProductBaseReadProjection;
export type CategoryReadProjection = { id: string; name: string; slug: string; description: Nullable<string>; parentId: Nullable<string>; displayImageUrl: Nullable<string>; seoTitle: Nullable<string>; metaDescription: Nullable<string>; displayOrder: number; isActive: boolean; createdAt: string; updatedAt: string };
export type CollectionReadProjection = { id: string; name: string; slug: string; description: Nullable<string>; coverImageUrl: Nullable<string>; seoTitle: Nullable<string>; metaDescription: Nullable<string>; displayOrder: number; isActive: boolean; createdAt: string; updatedAt: string };
export type ProductPhotoReadProjection = { id: string; productId: string; url: string; thumbnailUrl: string; altText: Nullable<string>; sortOrder: number; isPrimary: boolean; filename: string; mimeType: string; sizeBytes: number; width: number; height: number; processingStatus: string; storageKey: Nullable<string>; thumbnailStorageKey: Nullable<string>; processingErrorCode: Nullable<string>; processingUpdatedAt: Nullable<string>; createdAt: string; updatedAt: string };
export type ProductBreakdownDimension = "category" | "brand" | "condition" | "workflowStatus";
export type ProductBreakdownGroup = { key: string; productCount: number; stockQuantity: number; inventoryValue: number };

export interface ProductReadRepository { getById(id: string): Promise<ProductDetailProjection | undefined>; getBySku(sku: string): Promise<ProductDetailProjection | undefined>; getByErpReference(erpReferenceId: string): Promise<ProductDetailProjection | undefined>; getByNoctellaId(id: string): Promise<ProductDetailProjection | undefined>; list(query?: ProductReadListQuery): Promise<ProductListProjection[]>; listForExport(query?: ProductReadListQuery): Promise<ProductListProjection[]>; breakdownByDimension(dimension: ProductBreakdownDimension): Promise<ProductBreakdownGroup[]>; search(query: string, options?: ProductReadListQuery): Promise<ProductListProjection[]>; count(query?: ProductReadListQuery): Promise<number>; listUpdatedSince(updatedSince: string, options?: ProductReadListQuery): Promise<ProductListProjection[]>; listByCategory(categoryId: string, options?: ProductReadListQuery): Promise<ProductListProjection[]>; listByCollection(collectionId: string, options?: ProductReadListQuery): Promise<ProductListProjection[]>; listByStatus(status: string, options?: ProductReadListQuery): Promise<ProductListProjection[]>; listPublished(options?: ProductReadListQuery): Promise<ProductPublicProjection[]>; getAvailabilityProjection(productId: string): Promise<ProductAvailabilityProjection | undefined>; getWorkspaceReadProjection(productId: string): Promise<ProductWorkspaceReadProjection | undefined>; }
export interface CategoryReadRepository { getById(id:string):Promise<CategoryReadProjection|undefined>; getBySlug(slug:string):Promise<CategoryReadProjection|undefined>; list(q?:any):Promise<CategoryReadProjection[]>; count(q?:any):Promise<number>; listWithProductCounts(q?:any):Promise<Array<{ category: CategoryReadProjection; productCount: number }>>; listPublic():Promise<CategoryReadProjection[]>; }
export interface CollectionReadRepository { getById(id:string):Promise<CollectionReadProjection|undefined>; getBySlug(slug:string):Promise<CollectionReadProjection|undefined>; list(q?:any):Promise<CollectionReadProjection[]>; count(q?:any):Promise<number>; listWithProductCounts(q?:any):Promise<Array<{ collection: CollectionReadProjection; productCount: number }>>; listPublic():Promise<CollectionReadProjection[]>; }
export interface ProductPhotoReadRepository { getById(id:string):Promise<ProductPhotoReadProjection|undefined>; listByProduct(productId:string):Promise<ProductPhotoReadProjection[]>; getPrimaryByProduct(productId:string):Promise<ProductPhotoReadProjection|undefined>; countByProduct(productId:string):Promise<number>; listReadyByProduct(productId:string):Promise<ProductPhotoReadProjection[]>; listAdminByProduct(productId:string):Promise<ProductPhotoReadProjection[]>; listLegacyCompatibleByProduct(productId:string):Promise<ProductPhotoReadProjection[]>; }
export type ProductReadRepositoryBundle = { products: ProductReadRepository; categories: CategoryReadRepository; collections: CollectionReadRepository; photos: ProductPhotoReadRepository; shutdown?: () => Promise<void> };
export type ProductReadServiceContext = { repositories: ProductReadRepositoryBundle };
