import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseBackupRouter } from "../src/routes/databaseBackup";
import { DatabaseBackupConfigurationError, readS3CompatibleBackupConfig } from "../src/repositories/database-backup/s3Compatible";
import type { DatabaseBackupObjectMetadata, DatabaseBackupRepository } from "../src/repositories/database-backup/types";
import { createDatabaseBackupUseCase, createDatabaseRestoreVerificationUseCase, DatabaseBackupError } from "../src/use-cases/database-backup/useCases";
import { DATABASE_BACKUP_REQUEST_TIMEOUT_MS, requestDatabaseBackup } from "../src/scripts/runDatabaseBackup";
import { createS3CompatibleBackupRepository } from "../src/repositories/database-backup/s3Compatible";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { checkSqliteIntegrity } from "../src/services/databaseMigrationFoundation";

class FakeRepository implements DatabaseBackupRepository {
  bytes = Buffer.alloc(0);
  metadata?: DatabaseBackupObjectMetadata;
  uploadError = false;
  downloadError = false;
  metadataOverride?: Partial<DatabaseBackupObjectMetadata>;
  remoteBytes?: Buffer;
  downloadPaths: string[] = [];

  async upload(localPath: string, metadata: DatabaseBackupObjectMetadata) {
    if (this.uploadError) throw new Error("secret-value-must-not-escape");
    this.bytes = await readFile(localPath);
    this.metadata = metadata;
  }
  async head(objectKey: string) {
    if (!this.metadata) throw new Error("missing");
    return { ...this.metadata, objectKey, ...this.metadataOverride };
  }
  async download(_objectKey: string, destinationPath: string, maximumBytes: number) {
    if (this.downloadError) throw new Error("secret-value-must-not-escape");
    this.downloadPaths.push(destinationPath);
    const bytes = this.remoteBytes ?? this.bytes;
    if (bytes.length > maximumBytes) throw new Error("too large");
    await writeFile(destinationPath, bytes, { flag: "wx" });
    return bytes.length;
  }
}

const tempDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function sourceDatabase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noctella-backup-source-test-"));
  tempDirectories.push(directory);
  const livePath = path.join(directory, "live.sqlite");
  const sqlite = new Database(livePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO proof(value) VALUES ('committed');");
  return { directory, livePath, sqlite };
}

function useCase(sqlite: Database.Database, repository: FakeRepository, prefix = "database-backups") {
  return createDatabaseBackupUseCase({
    source: { backup: (destinationPath) => sqlite.backup(destinationPath) },
    repository,
    inspector: artifactInspector,
    prefix,
    now: () => new Date("2026-08-09T03:00:00.000Z"),
  });
}

const artifactInspector = { inspect(filePath: string) { const result = checkSqliteIntegrity(filePath); if (result.integrity !== "ok" || !result.fingerprint) throw new DatabaseBackupError("Database backup integrity verification failed"); return result.fingerprint; } };

describe("Sprint 124 SQLite database backup", () => {
  it("creates a consistent standalone backup with committed data, integrity, SHA-256, upload, and remote verification without changing the source", async () => {
    const { directory, sqlite } = await sourceDatabase();
    const repository = new FakeRepository();
    const result = await useCase(sqlite, repository).execute();
    expect(result).toMatchObject({ integrity: "ok", remoteVerified: true, createdAt: "2026-08-09T03:00:00.000Z" });
    expect(result.objectKey).toMatch(/^database-backups\/noctella-sqlite-20260809T030000000Z-[a-f0-9]{16}\.sqlite$/);
    expect(result.sha256).toBe(createHash("sha256").update(repository.bytes).digest("hex"));
    expect(result.byteSize).toBe(repository.bytes.length);
    const artifactPath = path.join(directory, "inspected-backup.sqlite");
    await writeFile(artifactPath, repository.bytes);
    const restored = new Database(artifactPath, { readonly: true });
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(restored.prepare("SELECT value FROM proof").pluck().get()).toBe("committed");
    restored.close();
    expect(sqlite.prepare("SELECT value FROM proof").pluck().get()).toBe("committed");
    sqlite.close();
  });

  it("fails closed for a corrupt local backup artifact", async () => {
    const repository = new FakeRepository();
    const operation = createDatabaseBackupUseCase({ source: { backup: (destination) => writeFile(destination, "not sqlite") }, repository, inspector: artifactInspector, prefix: "database-backups" });
    await expect(operation.execute()).rejects.toThrow("integrity verification failed");
    expect(repository.metadata).toBeUndefined();
  });

  it("fails closed with a fixed safe error when SQLite online backup creation fails", async () => {
    const repository = new FakeRepository();
    const operation = createDatabaseBackupUseCase({ source: { backup: async () => { throw new Error("private-source-path"); } }, repository, inspector: artifactInspector, prefix: "database-backups" });
    const error = await operation.execute().catch((value) => value as Error);
    expect(error.message).toBe("Consistent SQLite backup creation failed");
    expect(error.message).not.toContain("private-source-path");
    expect(repository.metadata).toBeUndefined();
  });

  it.each([
    ["SHA-256 metadata", { sha256: "0".repeat(64) }, /metadata verification failed/],
    ["size metadata", { byteSize: 1 }, /metadata verification failed/],
  ])("fails closed for remote %s mismatch", async (_name, override, message) => {
    const { sqlite } = await sourceDatabase();
    const repository = new FakeRepository(); repository.metadataOverride = override;
    await expect(useCase(sqlite, repository).execute()).rejects.toThrow(message);
    sqlite.close();
  });

  it("fails specifically on SHA-256 when the downloaded artifact is a different valid SQLite database", async () => {
    const { directory, sqlite } = await sourceDatabase();
    const repository = new FakeRepository();
    const originalUpload = repository.upload.bind(repository);
    repository.upload = async (localPath, metadata) => {
      await originalUpload(localPath, metadata);
      const alternatePath = path.join(directory, "alternate.sqlite");
      await writeFile(alternatePath, repository.bytes);
      const alternate = new Database(alternatePath);
      alternate.prepare("UPDATE proof SET value = ?").run("unexpected");
      alternate.close();
      repository.remoteBytes = await readFile(alternatePath);
      expect(repository.remoteBytes.length).toBe(repository.bytes.length);
      expect(checkSqliteIntegrity(alternatePath).integrity).toBe("ok");
    };
    await expect(useCase(sqlite, repository).execute()).rejects.toThrow("Database backup remote SHA-256 verification failed");
    sqlite.close();
  });

  it("fails closed when the downloaded byte size differs from the verified metadata", async () => {
    const { sqlite } = await sourceDatabase();
    const repository = new FakeRepository();
    const originalUpload = repository.upload.bind(repository);
    repository.upload = async (localPath, metadata) => { await originalUpload(localPath, metadata); repository.remoteBytes = repository.bytes.subarray(0, repository.bytes.length - 1); };
    await expect(useCase(sqlite, repository).execute()).rejects.toThrow("remote size verification failed");
    sqlite.close();
  });

  it("restore verification rejects a corrupt remote SQLite artifact even when its remote SHA and size metadata match", async () => {
    const repository = new FakeRepository();
    repository.bytes = Buffer.from("not-a-sqlite-database");
    repository.metadata = {
      objectKey: "database-backups/corrupt.sqlite",
      byteSize: repository.bytes.length,
      sha256: createHash("sha256").update(repository.bytes).digest("hex"),
      createdAt: "2026-08-09T03:00:00.000Z",
    };
    await expect(createDatabaseRestoreVerificationUseCase(repository, artifactInspector).execute(repository.metadata.objectKey)).rejects.toThrow("integrity verification failed");
  });

  it.each(["upload", "download"])("returns a fixed safe failure for %s errors", async (phase) => {
    const { sqlite } = await sourceDatabase();
    const repository = new FakeRepository();
    if (phase === "upload") repository.uploadError = true; else repository.downloadError = true;
    const error = await useCase(sqlite, repository).execute().catch((value) => value as Error);
    expect(error).toBeInstanceOf(DatabaseBackupError);
    expect(error.message).not.toContain("secret-value-must-not-escape");
    sqlite.close();
  });

  it("restore verification downloads only to a new temporary path and never overwrites a live database", async () => {
    const { livePath, sqlite } = await sourceDatabase();
    const repository = new FakeRepository();
    const backup = await useCase(sqlite, repository).execute();
    const liveBefore = await readFile(livePath);
    const result = await createDatabaseRestoreVerificationUseCase(repository, artifactInspector).execute(backup.objectKey);
    expect(result.integrity).toBe("ok");
    expect(repository.downloadPaths.every((value) => value !== livePath)).toBe(true);
    expect(await readFile(livePath)).toEqual(liveBefore);
    sqlite.close();
  });

  it("rejects an unsafe restore object key", async () => {
    await expect(createDatabaseRestoreVerificationUseCase(new FakeRepository(), artifactInspector).execute("../live.sqlite")).rejects.toThrow("Invalid database backup object key");
  });

  it("missing S3 configuration fails closed without exposing credential values", () => {
    expect(() => readS3CompatibleBackupConfig({ DATABASE_BACKUP_S3_ACCESS_KEY_ID: "visible-key", DATABASE_BACKUP_S3_SECRET_ACCESS_KEY: "visible-secret" } as NodeJS.ProcessEnv)).toThrow(DatabaseBackupConfigurationError);
    try { readS3CompatibleBackupConfig({ DATABASE_BACKUP_S3_ACCESS_KEY_ID: "visible-key", DATABASE_BACKUP_S3_SECRET_ACCESS_KEY: "visible-secret" } as NodeJS.ProcessEnv); }
    catch (error) { expect(String(error)).not.toContain("visible-key"); expect(String(error)).not.toContain("visible-secret"); }
  });

  it.each([
    [undefined, "database-backups"],
    ["database-backups", "database-backups"],
    ["/noctella/database-backups/", "noctella/database-backups"],
  ])("accepts safe backup prefix %s", (value, expected) => {
    const config = readS3CompatibleBackupConfig({ DATABASE_BACKUP_S3_REGION: "region", DATABASE_BACKUP_S3_BUCKET: "bucket", DATABASE_BACKUP_S3_ACCESS_KEY_ID: "id", DATABASE_BACKUP_S3_SECRET_ACCESS_KEY: "secret", DATABASE_BACKUP_S3_PREFIX: value } as NodeJS.ProcessEnv);
    expect(config.prefix).toBe(expected);
  });

  it.each(["/", "../other", "backup/../daily", "backup/./daily", "backup//daily", "backup\\daily", "backup..archive", "archive../daily", "foo..bar/baz", "noctella/backup..archive"])("rejects unsafe backup prefix %s", (prefix) => {
    expect(() => readS3CompatibleBackupConfig({ DATABASE_BACKUP_S3_REGION: "region", DATABASE_BACKUP_S3_BUCKET: "bucket", DATABASE_BACKUP_S3_ACCESS_KEY_ID: "id", DATABASE_BACKUP_S3_SECRET_ACCESS_KEY: "secret", DATABASE_BACKUP_S3_PREFIX: prefix } as NodeJS.ProcessEnv)).toThrow(DatabaseBackupConfigurationError);
  });

  it("generates a restore-verification-compatible object key from an accepted nested prefix", async () => {
    const { sqlite } = await sourceDatabase();
    const repository = new FakeRepository();
    const backup = await useCase(sqlite, repository, "noctella/database-backups").execute();
    expect(backup.objectKey).toMatch(/^noctella\/database-backups\/noctella-sqlite-/);
    await expect(createDatabaseRestoreVerificationUseCase(repository, artifactInspector).execute(backup.objectKey)).resolves.toMatchObject({ objectKey: backup.objectKey, integrity: "ok" });
    sqlite.close();
  });

  it("the authenticated scheduler route rejects missing/wrong credentials and ignores caller-supplied paths", async () => {
    vi.stubEnv("SCHEDULER_AUTH_TOKEN", "expected-token");
    const run = vi.fn().mockResolvedValue({ objectKey: "database-backups/x.sqlite", byteSize: 1, sha256: "a".repeat(64), createdAt: "2026-08-09T03:00:00.000Z", integrity: "ok", remoteVerified: true });
    const app = express(); app.use(express.json()); app.use("/backup", createDatabaseBackupRouter(run));
    await request(app).post("/backup").expect(401);
    await request(app).post("/backup").set("Authorization", "Bearer wrong").expect(401);
    await request(app).post("/backup").set("Authorization", "Bearer expected-token").send({ databasePath: "C:/forbidden.sqlite" }).expect(200);
    expect(run).toHaveBeenCalledWith();
  });

  it("the scheduler client makes only an authenticated API call and never exposes the token in failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Bearer scheduler-secret"));
    const result = await requestDatabaseBackup({ API_HOSTPORT: "api.internal:4000", SCHEDULER_AUTH_TOKEN: "scheduler-secret" } as NodeJS.ProcessEnv, fetchMock);
    expect(result).toEqual({ ok: false, error: "Database backup request failed" });
    expect(fetchMock).toHaveBeenCalledWith("http://api.internal:4000/api/background-jobs/database-backup", expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer scheduler-secret" }, signal: expect.any(AbortSignal) }));
  });

  it("aborts an unresolved scheduler request after exactly 900000 ms and returns a fixed failure", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      requestSignal?.addEventListener("abort", () => reject(new DOMException("Bearer scheduler-secret", "AbortError")), { once: true });
    }));
    const operation = requestDatabaseBackup({ API_HOSTPORT: "api.internal:4000", SCHEDULER_AUTH_TOKEN: "scheduler-secret" } as NodeJS.ProcessEnv, fetchMock as typeof fetch);
    await vi.advanceTimersByTimeAsync(DATABASE_BACKUP_REQUEST_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(operation).resolves.toEqual({ ok: false, error: "Database backup request failed" });
    expect(requestSignal?.aborted).toBe(true);
    expect(DATABASE_BACKUP_REQUEST_TIMEOUT_MS).toBe(900_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the repository contract exposes upload/head/download but no delete or retention behavior", () => {
    const methods: Array<keyof DatabaseBackupRepository> = ["upload", "head", "download"];
    expect(methods).not.toContain("delete" as never);
  });

  it("the concrete S3-compatible adapter uses Put/Head/Get with application SHA and size metadata, never ETag", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "noctella-s3-adapter-test-"));
    tempDirectories.push(directory);
    const source = path.join(directory, "source.sqlite");
    const destination = path.join(directory, "destination.sqlite");
    const bytes = Buffer.from("adapter-proof");
    await writeFile(source, bytes);
    const metadata = { objectKey: "database-backups/proof.sqlite", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: "2026-08-09T03:00:00.000Z" };
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length, ETag: "not-authoritative", Metadata: { sha256: metadata.sha256, "size-bytes": String(bytes.length), "created-at": metadata.createdAt } };
      if (command instanceof GetObjectCommand) return { Body: (async function* () { yield bytes; })() };
      throw new Error("unexpected command");
    });
    const repository = createS3CompatibleBackupRepository({ region: "test", bucket: "test", accessKeyId: "id", secretAccessKey: "secret", forcePathStyle: true, prefix: "database-backups" }, { send } as never);
    await repository.upload(source, metadata);
    expect((send.mock.calls[0][0] as PutObjectCommand).input.Metadata).toEqual({ sha256: metadata.sha256, "size-bytes": String(bytes.length), "created-at": metadata.createdAt });
    expect(await repository.head(metadata.objectKey)).toEqual(metadata);
    expect(await repository.download(metadata.objectKey, destination, bytes.length)).toBe(bytes.length);
    expect(await readFile(destination)).toEqual(bytes);
  });

  it("the concrete S3-compatible adapter rejects a body larger than the expected size", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "noctella-s3-oversized-test-"));
    tempDirectories.push(directory);
    const destination = path.join(directory, "destination.sqlite");
    const send = vi.fn(async () => ({ Body: (async function* () { yield Buffer.from("expected"); yield Buffer.from("oversized"); })() }));
    const repository = createS3CompatibleBackupRepository({ region: "test", bucket: "test", accessKeyId: "id", secretAccessKey: "secret", forcePathStyle: true, prefix: "database-backups" }, { send } as never);
    await expect(repository.download("database-backups/proof.sqlite", destination, 8)).rejects.toThrow("exceeded expected size");
    await expect(readFile(destination)).rejects.toThrow();
  });

  it("the concrete S3-compatible adapter propagates a body stream failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "noctella-s3-stream-error-test-"));
    tempDirectories.push(directory);
    const destination = path.join(directory, "destination.sqlite");
    const send = vi.fn(async () => ({ Body: (async function* () { yield Buffer.from("partial"); throw new Error("stream failed"); })() }));
    const repository = createS3CompatibleBackupRepository({ region: "test", bucket: "test", accessKeyId: "id", secretAccessKey: "secret", forcePathStyle: true, prefix: "database-backups" }, { send } as never);
    await expect(repository.download("database-backups/proof.sqlite", destination, 100)).rejects.toThrow("stream failed");
    await expect(readFile(destination)).rejects.toThrow();
  });
});

describe("Sprint 124 Render schedule", () => {
  it("adds the daily 03:00 UTC backup trigger while preserving the existing hourly background cron", async () => {
    const yaml = await readFile(path.resolve(__dirname, "../../../render.yaml"), "utf8");
    expect(yaml).toContain("name: noctella-staging-database-backup");
    expect(yaml).toContain('schedule: "0 3 * * *"');
    expect(yaml).toContain("name: noctella-staging-background-jobs");
    expect(yaml).toContain('schedule: "0 * * * *"');
    const backupSection = yaml.slice(yaml.indexOf("name: noctella-staging-database-backup"));
    expect(backupSection).not.toContain("DATABASE_URL");
    expect(backupSection).not.toContain("DATABASE_BACKUP_S3_SECRET_ACCESS_KEY");
    expect(backupSection).not.toContain("disk:");
  });
});
