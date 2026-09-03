import { link, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
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

function validateObjectKey(objectKeyValue: string, expectedPrefix?: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.sqlite$/.test(objectKeyValue) || objectKeyValue.includes("..")) throw new DatabaseBackupError("Invalid database backup object key");
  if (expectedPrefix && !objectKeyValue.startsWith(`${expectedPrefix}/`)) throw new DatabaseBackupError("Invalid database backup object key");
}

function validateRemoteMetadata(metadata: DatabaseBackupObjectMetadata, objectKeyValue: string) {
  if (metadata.objectKey !== objectKeyValue || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize <= 0 || !metadata.createdAt || Number.isNaN(Date.parse(metadata.createdAt))) {
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
      validateObjectKey(objectKeyValue);
      let metadata: DatabaseBackupObjectMetadata;
      try { metadata = await repository.head(objectKeyValue); }
      catch { throw new DatabaseBackupError("Database backup remote metadata read failed"); }
      validateRemoteMetadata(metadata, objectKeyValue);
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

function comparablePath(value: string) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function resolvedDestinationPath(destination: string) {
  if (!destination.trim() || destination.includes("\0") || path.extname(destination).toLowerCase() !== ".sqlite") throw new DatabaseBackupError("Invalid database restore destination");
  const absolute = path.resolve(destination);
  let parent: string;
  try { parent = await realpath(path.dirname(absolute)); }
  catch { throw new DatabaseBackupError("Database restore destination directory is invalid"); }
  if (!(await stat(parent)).isDirectory()) throw new DatabaseBackupError("Database restore destination directory is invalid");
  return path.join(parent, path.basename(absolute));
}

async function comparableLiveDatabasePath(liveDatabasePath: string) {
  const absolute = path.resolve(liveDatabasePath);
  try { return comparablePath(await realpath(absolute)); }
  catch {
    try { return comparablePath(path.join(await realpath(path.dirname(absolute)), path.basename(absolute))); }
    catch { return comparablePath(absolute); }
  }
}

export function createDatabaseRestoreMaterializationUseCase(dependencies: {
  repository: DatabaseBackupRepository;
  inspector: DatabaseBackupArtifactInspector;
  expectedPrefix: string;
  liveDatabasePath: string;
  removeTemporaryWorkspace?: (directory: string) => Promise<void>;
}) {
  return {
    async execute(objectKeyValue: string, requestedDestination: string): Promise<DatabaseBackupObjectMetadata & { destination: string; integrity: "ok" }> {
      validateObjectKey(objectKeyValue, dependencies.expectedPrefix);
      if (!dependencies.liveDatabasePath.trim() || dependencies.liveDatabasePath === ":memory:") throw new DatabaseBackupError("Live SQLite database path is not configured");
      const destination = await resolvedDestinationPath(requestedDestination);
      if (comparablePath(destination) === await comparableLiveDatabasePath(dependencies.liveDatabasePath)) throw new DatabaseBackupError("Database restore destination must not be the live database");
      try { await lstat(destination); throw new DatabaseBackupError("Database restore destination already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

      let metadata: DatabaseBackupObjectMetadata;
      try { metadata = await dependencies.repository.head(objectKeyValue); }
      catch { throw new DatabaseBackupError("Database backup remote metadata read failed"); }
      validateRemoteMetadata(metadata, objectKeyValue);

      let directory: string;
      try { directory = await mkdtemp(path.join(path.dirname(destination), ".noctella-db-restore-")); }
      catch { throw new DatabaseBackupError("Database restore temporary workspace creation failed"); }
      const temporaryPath = path.join(directory, "candidate.sqlite");
      let failure: unknown;
      try {
        await verifyDownloadedArtifact(dependencies.repository, dependencies.inspector, metadata, temporaryPath);
        try { await link(temporaryPath, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DatabaseBackupError("Database restore destination already exists");
          throw new DatabaseBackupError("Database restore candidate publication failed");
        }
      } catch (error) { failure = error instanceof DatabaseBackupError ? error : new DatabaseBackupError("Database restore materialization failed"); }
      try {
        if (dependencies.removeTemporaryWorkspace) await dependencies.removeTemporaryWorkspace(directory);
        else await rm(directory, { recursive: true, force: true });
      }
      catch { if (!failure) failure = new DatabaseBackupError("Database restore temporary cleanup failed"); }
      if (failure) throw failure;
      return { ...metadata, destination, integrity: "ok" };
    },
  };
}
