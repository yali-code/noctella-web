import type Database from "better-sqlite3";
import type { DbClient } from "../db/client";
import { createS3CompatibleBackupRepository, readS3CompatibleBackupConfig } from "../repositories/database-backup/s3Compatible";
import { createDatabaseBackupUseCase, createDatabaseRestoreMaterializationUseCase, createDatabaseRestoreVerificationUseCase, DatabaseBackupError } from "../use-cases/database-backup/useCases";
import { checkSqliteIntegrity } from "./databaseMigrationFoundation";
import type { DatabaseBackupRepository } from "../repositories/database-backup/types";
import { BackupFailedError, createDiagnosticRecorder } from "./backupFailureDiagnostics";

function sqliteSource(db: DbClient) {
  const client = (db as unknown as { $client?: Database.Database }).$client;
  if (!client || typeof client.backup !== "function") throw new DatabaseBackupError("Database backup requires the API-owned SQLite runtime");
  return { backup: (destinationPath: string) => client.backup(destinationPath) };
}

const inspector = { inspect(filePath: string) { const result = checkSqliteIntegrity(filePath); if (result.integrity !== "ok" || !result.fingerprint) throw new DatabaseBackupError("Database backup integrity verification failed"); return result.fingerprint; } };

export async function runDatabaseBackup(db: DbClient, env: NodeJS.ProcessEnv = process.env) {
  let config: ReturnType<typeof readS3CompatibleBackupConfig>;
  let repository: DatabaseBackupRepository;
  try { config = readS3CompatibleBackupConfig(env); repository = createS3CompatibleBackupRepository(config); }
  catch { throw new BackupFailedError({ stage: "CONFIG", code: "CONFIG_MISSING_OR_INVALID", httpStatus: null, errorName: null }); }
  let source: ReturnType<typeof sqliteSource>;
  try { source = sqliteSource(db); }
  catch { throw new BackupFailedError({ stage: "LOCAL_SNAPSHOT", code: "LOCAL_SOURCE_FAILED", httpStatus: null, errorName: null }); }
  return executeDiagnosedDatabaseBackup({ source, repository, inspector, prefix: config.prefix });
}

/**
 * ADS-009F: runs the unchanged backup use case with step-boundary diagnostics; on failure throws
 * BackupFailedError carrying only the first classified failure (no message, path or key).
 */
export async function executeDiagnosedDatabaseBackup(dependencies: Parameters<typeof createDatabaseBackupUseCase>[0]) {
  const recorder = createDiagnosticRecorder();
  try {
    return await createDatabaseBackupUseCase({
      ...dependencies,
      source: { backup: recorder.step("LOCAL_SNAPSHOT", "LOCAL_SOURCE_FAILED", (p: string) => dependencies.source.backup(p)) },
      inspector: { inspect: recorder.step("INTEGRITY", "INTEGRITY_FAILED", (p: string) => dependencies.inspector.inspect(p)) },
      repository: recorder.storage(dependencies.repository),
    }).execute();
  } catch {
    throw new BackupFailedError(recorder.value ?? { stage: "VERIFY_OR_WORKSPACE", code: "VERIFICATION_OR_WORKSPACE_FAILED", httpStatus: null, errorName: null });
  }
}

export async function verifyRemoteDatabaseBackup(objectKey: string, env: NodeJS.ProcessEnv = process.env) {
  const config = readS3CompatibleBackupConfig(env);
  return createDatabaseRestoreVerificationUseCase(createS3CompatibleBackupRepository(config), inspector).execute(objectKey);
}

export async function materializeRemoteDatabaseBackup(objectKey: string, destination: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.DATABASE_DRIVER && env.DATABASE_DRIVER !== "sqlite") throw new DatabaseBackupError("Database restore materialization requires the SQLite runtime");
  const liveDatabasePath = env.DATABASE_URL?.trim();
  if (!liveDatabasePath) throw new DatabaseBackupError("Live SQLite database path is not configured");
  const config = readS3CompatibleBackupConfig(env);
  return createDatabaseRestoreMaterializationUseCase({
    repository: createS3CompatibleBackupRepository(config),
    inspector,
    expectedPrefix: config.prefix,
    liveDatabasePath,
  }).execute(objectKey, destination);
}
