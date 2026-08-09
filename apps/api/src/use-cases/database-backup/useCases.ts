import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseBackupObjectMetadata, DatabaseBackupRepository } from "../../repositories/database-backup/types";

export interface SqliteOnlineBackupSource { backup(destinationPath: string): Promise<unknown> }
export interface DatabaseBackupArtifactInspector { inspect(filePath: string): string }
export class DatabaseBackupError extends Error {
  constructor(message: string) { super(message); this.name = "DatabaseBackupError"; }
}

function assertMetadata(actual: DatabaseBackupObjectMetadata, expected: DatabaseBackupObjectMetadata) {
  if (actual.objectKey !== expected.objectKey || actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256 || actual.createdAt !== expected.createdAt) {
    throw new DatabaseBackupError("Database backup remote metadata verification failed");
  }
}

async function verifyDownloadedArtifact(repository: DatabaseBackupRepository, inspector: DatabaseBackupArtifactInspector, expected: DatabaseBackupObjectMetadata, destinationPath: string) {
  let downloadedBytes: number;
  try { downloadedBytes = await repository.download(expected.objectKey, destinationPath, expected.byteSize); }
  catch { throw new DatabaseBackupError("Database backup remote download failed"); }
  if (downloadedBytes !== expected.byteSize || (await stat(destinationPath)).size !== expected.byteSize) throw new DatabaseBackupError("Database backup remote size verification failed");
  if (inspector.inspect(destinationPath) !== expected.sha256) throw new DatabaseBackupError("Database backup remote SHA-256 verification failed");
}

function objectKey(prefix: string, createdAt: string, sha256: string) {
  const timestamp = createdAt.replace(/[-:.]/g, "");
  return `${prefix}/noctella-sqlite-${timestamp}-${sha256.slice(0, 16)}.sqlite`;
}

export function createDatabaseBackupUseCase(dependencies: {
  source: SqliteOnlineBackupSource;
  repository: DatabaseBackupRepository;
  inspector: DatabaseBackupArtifactInspector;
  prefix: string;
  now?: () => Date;
}) {
  return {
    async execute(): Promise<DatabaseBackupObjectMetadata & { integrity: "ok"; remoteVerified: true }> {
      let directory: string;
      try { directory = await mkdtemp(path.join(os.tmpdir(), "noctella-db-backup-")); }
      catch { throw new DatabaseBackupError("Database backup temporary workspace creation failed"); }
      const localPath = path.join(directory, "backup.sqlite");
      const remotePath = path.join(directory, "remote-verification.sqlite");
      let result: (DatabaseBackupObjectMetadata & { integrity: "ok"; remoteVerified: true }) | undefined;
      let failure: unknown;
      try {
        try { await dependencies.source.backup(localPath); }
        catch { throw new DatabaseBackupError("Consistent SQLite backup creation failed"); }
        const sha256 = dependencies.inspector.inspect(localPath);
        const byteSize = (await stat(localPath)).size;
        const createdAt = (dependencies.now ?? (() => new Date()))().toISOString();
        const metadata = { objectKey: objectKey(dependencies.prefix, createdAt, sha256), byteSize, sha256, createdAt };
        try { await dependencies.repository.upload(localPath, metadata); }
        catch { throw new DatabaseBackupError("Database backup upload failed"); }
        let remote: DatabaseBackupObjectMetadata;
        try { remote = await dependencies.repository.head(metadata.objectKey); }
        catch { throw new DatabaseBackupError("Database backup remote metadata read failed"); }
        assertMetadata(remote, metadata);
        await verifyDownloadedArtifact(dependencies.repository, dependencies.inspector, metadata, remotePath);
        result = { ...metadata, integrity: "ok", remoteVerified: true };
      } catch (error) { failure = error instanceof DatabaseBackupError ? error : new DatabaseBackupError("Database backup failed"); }
      try { await rm(directory, { recursive: true, force: true }); }
      catch { if (!failure) failure = new DatabaseBackupError("Database backup temporary cleanup failed"); }
      if (failure) throw failure;
      return result!;
    },
  };
}

export function createDatabaseRestoreVerificationUseCase(repository: DatabaseBackupRepository, inspector: DatabaseBackupArtifactInspector) {
  return {
    async execute(objectKeyValue: string): Promise<DatabaseBackupObjectMetadata & { integrity: "ok" }> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.sqlite$/.test(objectKeyValue) || objectKeyValue.includes("..")) throw new DatabaseBackupError("Invalid database backup object key");
      let metadata: DatabaseBackupObjectMetadata;
      try { metadata = await repository.head(objectKeyValue); }
      catch { throw new DatabaseBackupError("Database backup remote metadata read failed"); }
      if (!/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize <= 0) throw new DatabaseBackupError("Database backup remote metadata verification failed");
      let directory: string;
      try { directory = await mkdtemp(path.join(os.tmpdir(), "noctella-db-restore-verification-")); }
      catch { throw new DatabaseBackupError("Database restore verification temporary workspace creation failed"); }
      const destination = path.join(directory, "verification.sqlite");
      let failure: unknown;
      try { await verifyDownloadedArtifact(repository, inspector, metadata, destination); }
      catch (error) { failure = error; }
      try { await rm(directory, { recursive: true, force: true }); }
      catch { if (!failure) failure = new DatabaseBackupError("Database restore verification temporary cleanup failed"); }
      if (failure) throw failure;
      return { ...metadata, integrity: "ok" };
    },
  };
}
