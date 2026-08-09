import type Database from "better-sqlite3";
import type { DbClient } from "../db/client";
import { createS3CompatibleBackupRepository, readS3CompatibleBackupConfig } from "../repositories/database-backup/s3Compatible";
import { createDatabaseBackupUseCase, createDatabaseRestoreVerificationUseCase, DatabaseBackupError } from "../use-cases/database-backup/useCases";
import { checkSqliteIntegrity } from "./databaseMigrationFoundation";

function sqliteSource(db: DbClient) {
  const client = (db as unknown as { $client?: Database.Database }).$client;
  if (!client || typeof client.backup !== "function") throw new DatabaseBackupError("Database backup requires the API-owned SQLite runtime");
  return { backup: (destinationPath: string) => client.backup(destinationPath) };
}

const inspector = { inspect(filePath: string) { const result = checkSqliteIntegrity(filePath); if (result.integrity !== "ok" || !result.fingerprint) throw new DatabaseBackupError("Database backup integrity verification failed"); return result.fingerprint; } };

export async function runDatabaseBackup(db: DbClient, env: NodeJS.ProcessEnv = process.env) {
  const config = readS3CompatibleBackupConfig(env);
  const repository = createS3CompatibleBackupRepository(config);
  return createDatabaseBackupUseCase({ source: sqliteSource(db), repository, inspector, prefix: config.prefix }).execute();
}

export async function verifyRemoteDatabaseBackup(objectKey: string, env: NodeJS.ProcessEnv = process.env) {
  const config = readS3CompatibleBackupConfig(env);
  return createDatabaseRestoreVerificationUseCase(createS3CompatibleBackupRepository(config), inspector).execute(objectKey);
}
