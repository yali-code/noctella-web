import type { DbClient } from "../db/client";
import { createProductPhotoBackupReferenceSource } from "../repositories/product-photo-backup/drizzleSource";
import { createS3CompatibleProductPhotoBackupRepository, readS3CompatibleProductPhotoBackupConfig } from "../repositories/product-photo-backup/s3Compatible";
import { createProductPhotoBackupUseCase, createProductPhotoRecoveryVerificationUseCase } from "../use-cases/product-photo-backup/useCases";
import { productPhotoStaticRoot } from "./photoStorage";
import { createProductPhotoLocalFileSource } from "./productPhotoBackupLocalSource";
import { BackupFailedError, createDiagnosticRecorder } from "./backupFailureDiagnostics";

export async function runProductPhotoBackup(db: DbClient, env: NodeJS.ProcessEnv = process.env) {
  let config: ReturnType<typeof readS3CompatibleProductPhotoBackupConfig>;
  let repository: ReturnType<typeof createS3CompatibleProductPhotoBackupRepository>;
  try { config = readS3CompatibleProductPhotoBackupConfig(env); repository = createS3CompatibleProductPhotoBackupRepository(config); }
  catch { throw new BackupFailedError({ stage: "CONFIG", code: "CONFIG_MISSING_OR_INVALID", httpStatus: null, errorName: null }); }
  return executeDiagnosedProductPhotoBackup({ references: createProductPhotoBackupReferenceSource(db), files: createProductPhotoLocalFileSource(productPhotoStaticRoot), repository, prefix: config.prefix });
}

/** ADS-009F: unchanged use case with step-boundary diagnostics (see backupFailureDiagnostics.ts). */
export async function executeDiagnosedProductPhotoBackup(dependencies: Parameters<typeof createProductPhotoBackupUseCase>[0]) {
  const recorder = createDiagnosticRecorder();
  const { references, files } = dependencies;
  try {
    return await createProductPhotoBackupUseCase({
      ...dependencies,
      references: { ...references, listPage: recorder.step("LOCAL_DB_READ", "LOCAL_SOURCE_FAILED", references.listPage.bind(references)) },
      files: { ...files, inspect: recorder.step("LOCAL_FILE", "LOCAL_SOURCE_FAILED", files.inspect.bind(files)) },
      repository: recorder.storage(dependencies.repository),
    }).execute();
  } catch {
    throw new BackupFailedError(recorder.value ?? { stage: "VERIFY_OR_WORKSPACE", code: "VERIFICATION_OR_WORKSPACE_FAILED", httpStatus: null, errorName: null });
  }
}

export async function verifyRemoteProductPhotoBackup(manifestKey: string, env: NodeJS.ProcessEnv = process.env) {
  const config = readS3CompatibleProductPhotoBackupConfig(env);
  return createProductPhotoRecoveryVerificationUseCase(createS3CompatibleProductPhotoBackupRepository(config), config.prefix).execute(manifestKey);
}
