export type Nullable<T> = T | null;
export type ProductPersistenceRecord = Record<string, string | number | boolean | null>;
export type CategoryPersistenceRecord = Record<string, string | number | boolean | null>;
export type CollectionPersistenceRecord = Record<string, string | number | boolean | null>;
export type ProductPhotoPersistenceRecord = Record<string, string | number | boolean | null>;
export type ProductErpMetadataRecord = Record<string, string | number | null> & { productId: string };

export interface CreateProductInput { values: ProductPersistenceRecord }
export interface UpdateProductInput { id: string; values: ProductPersistenceRecord; expectedUpdatedAt?: Nullable<string> }
export interface CreateProductResult { id: string }
export interface UpdateProductResult { id: string; updated: boolean; conflict?: ProductWriteConflict }
export interface CreateCategoryInput { values: CategoryPersistenceRecord }
export interface UpdateCategoryInput { id: string; values: CategoryPersistenceRecord }
export interface CreateCollectionInput { values: CollectionPersistenceRecord }
export interface UpdateCollectionInput { id: string; values: CollectionPersistenceRecord }
export interface CreateProductPhotoMetadataInput { values: ProductPhotoPersistenceRecord }
export interface UpdateProductPhotoAltInput { productId: string; photoId: string; altText: Nullable<string> }
export interface SetPrimaryPhotoInput { productId: string; photoId: string }
export interface ReorderProductPhotosInput { productId: string; photoIds: string[] }
export interface DeleteProductPhotoMetadataInput { productId: string; photoId: string }
export interface ProductWriteConflict { field: string; value: string; message: string }
export interface ProductWriteIssue { code: string; message: string; field?: string }
export interface ProductWriteExecutionResult<T = unknown> { ok: boolean; value?: T; issues: ProductWriteIssue[] }

export interface ProductWriteRepository {
  create(input: CreateProductInput): Promise<CreateProductResult>;
  update(input: UpdateProductInput): Promise<UpdateProductResult>;
  existsBySku(sku: string, excludeId?: string): Promise<boolean>;
  existsByErpReference(erpReferenceId: string, excludeId?: string): Promise<boolean>;
  existsByNoctellaId(noctellaId: string, excludeProductId?: string): Promise<boolean>;
  getVersionForUpdate(id: string): Promise<Nullable<string>>;
  updateWithExpectedVersion(input: UpdateProductInput): Promise<UpdateProductResult>;
  createErpMetadata(record: ProductErpMetadataRecord): Promise<void>;
  updateErpMetadata(productId: string, values: Partial<ProductErpMetadataRecord>): Promise<void>;
  getErpMetadataForUpdate(productId: string): Promise<Nullable<ProductErpMetadataRecord>>;
}
export type SynchronousProductWriteRepository = {
  [Key in keyof ProductWriteRepository]: ProductWriteRepository[Key] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Result
    : ProductWriteRepository[Key];
};
export interface CategoryWriteRepository {
  create(input: CreateCategoryInput): Promise<{ id: string }>;
  update(input: UpdateCategoryInput): Promise<{ id: string }>;
  existsByName(name: string, excludeId?: string): Promise<boolean>;
  existsBySlug(slug: string, excludeId?: string): Promise<boolean>;
  getVersionForUpdate(id: string): Promise<Nullable<string>>;
}
export interface CollectionWriteRepository {
  create(input: CreateCollectionInput): Promise<{ id: string }>;
  update(input: UpdateCollectionInput): Promise<{ id: string }>;
  existsByName(name: string, excludeId?: string): Promise<boolean>;
  existsBySlug(slug: string, excludeId?: string): Promise<boolean>;
  getVersionForUpdate(id: string): Promise<Nullable<string>>;
}
export interface ProductPhotoWriteRepository {
  createMetadata(input: CreateProductPhotoMetadataInput): Promise<{ id: string }>;
  updateAltText(input: UpdateProductPhotoAltInput): Promise<void>;
  setPrimary(input: SetPrimaryPhotoInput): Promise<void>;
  reorder(input: ReorderProductPhotosInput): Promise<void>;
  deleteMetadata(input: DeleteProductPhotoMetadataInput): Promise<void>;
  promoteNextPrimary(productId: string): Promise<void>;
  updateProcessingState(photoId: string, state: { processingStatus: string; processingErrorCode?: Nullable<string>; processingUpdatedAt: string }): Promise<void>;
  updateStorageMetadata(photoId: string, metadata: { url?: string; thumbnailUrl?: string; storageKey?: Nullable<string>; thumbnailStorageKey?: Nullable<string>; width?: number; height?: number; sizeBytes?: number }): Promise<void>;
  getForUpdate(productId: string, photoId: string): Promise<Nullable<ProductPhotoPersistenceRecord>>;
  listForUpdate(productId: string): Promise<ProductPhotoPersistenceRecord[]>;
}
export interface ProductWriteRepositoryBundle { products: ProductWriteRepository; categories: CategoryWriteRepository; collections: CollectionWriteRepository; photos: ProductPhotoWriteRepository }
