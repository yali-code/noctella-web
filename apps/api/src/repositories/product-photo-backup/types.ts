export type ProductPhotoArtifactRole = "main" | "thumbnail";

export const MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface ProductPhotoBackupReference {
  photoId: string;
  productId: string;
  mimeType: string;
  locallyOwned: boolean;
  mainStorageKey?: string;
  thumbnailStorageKey?: string;
}

export interface ProductPhotoBackupReferencePage {
  items: ProductPhotoBackupReference[];
  nextCursor?: string;
}

export interface ProductPhotoBackupReferenceSource {
  listPage(cursor: string | undefined, limit: number): Promise<ProductPhotoBackupReferencePage>;
}

export interface ProductPhotoBackupObjectMetadata {
  objectKey: string;
  byteSize: number;
  sha256: string;
  contentType: string;
  createdAt: string;
}

export interface ProductPhotoBackupRepository {
  head(objectKey: string): Promise<ProductPhotoBackupObjectMetadata | null>;
  upload(localPath: string, metadata: ProductPhotoBackupObjectMetadata): Promise<void>;
  download(objectKey: string, destinationPath: string, maximumBytes: number): Promise<number>;
}

export interface InspectedProductPhotoArtifact {
  localPath: string;
  byteSize: number;
  sha256: string;
}

export interface ProductPhotoLocalFileSource {
  inspect(storageKey: string): Promise<InspectedProductPhotoArtifact>;
}
