export interface DatabaseBackupObjectMetadata {
  objectKey: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface DatabaseBackupRepository {
  upload(localPath: string, metadata: DatabaseBackupObjectMetadata): Promise<void>;
  head(objectKey: string): Promise<DatabaseBackupObjectMetadata>;
  download(objectKey: string, destinationPath: string, maximumBytes: number): Promise<number>;
}
