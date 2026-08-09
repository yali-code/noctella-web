import type { DbClient } from "../db/client";
import { createProductPhotoBackupReferenceSource } from "../repositories/product-photo-backup/drizzleSource";
import { createS3CompatibleProductPhotoBackupRepository, readS3CompatibleProductPhotoBackupConfig } from "../repositories/product-photo-backup/s3Compatible";
import { createProductPhotoBackupUseCase, createProductPhotoRecoveryVerificationUseCase } from "../use-cases/product-photo-backup/useCases";
import { productPhotoStaticRoot } from "./photoStorage";
import { createProductPhotoLocalFileSource } from "./productPhotoBackupLocalSource";

export async function runProductPhotoBackup(db: DbClient, env: NodeJS.ProcessEnv = process.env) {
  const config = readS3CompatibleProductPhotoBackupConfig(env);
  return createProductPhotoBackupUseCase({ references: createProductPhotoBackupReferenceSource(db), files: createProductPhotoLocalFileSource(productPhotoStaticRoot), repository: createS3CompatibleProductPhotoBackupRepository(config), prefix: config.prefix }).execute();
}

export async function verifyRemoteProductPhotoBackup(manifestKey: string, env: NodeJS.ProcessEnv = process.env) {
  const config = readS3CompatibleProductPhotoBackupConfig(env);
  return createProductPhotoRecoveryVerificationUseCase(createS3CompatibleProductPhotoBackupRepository(config), config.prefix).execute(manifestKey);
}
