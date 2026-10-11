// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3CompatibleBackupRepository, readS3CompatibleBackupConfig } from "../src/repositories/database-backup/s3Compatible";
import { createS3CompatibleProductPhotoBackupRepository, readS3CompatibleProductPhotoBackupConfig } from "../src/repositories/product-photo-backup/s3Compatible";
import { createDatabaseBackupRouter } from "../src/routes/databaseBackup";
import { createProductPhotoBackupRouter } from "../src/routes/productPhotoBackup";
import { BackupFailedError, classifyStorageError, logBackupFailure } from "../src/services/backupFailureDiagnostics";
import { executeDiagnosedDatabaseBackup, runDatabaseBackup } from "../src/services/databaseBackup";
import { executeDiagnosedProductPhotoBackup, runProductPhotoBackup } from "../src/services/productPhotoBackup";
import { checkSqliteIntegrity } from "../src/services/databaseMigrationFoundation";

/**
 * ADS-009F: backup failures are diagnosable from logs without leaking anything. Every fixture
 * error carries SENSITIVE-* markers in places a careless logger would print (message, stack,
 * bucket, key, endpoint, request id); none may appear in diagnostics or responses.
 */
const SENSITIVE = /SENSITIVE|stack|r2\.example|bucket-name|\.sqlite|\/tmp|\\Temp/i;
function sdkError(name: string, status: number | undefined, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`SENSITIVE message for bucket-name SENSITIVE-key at https://SENSITIVE.r2.example`), {
    name, $metadata: status === undefined ? undefined : { httpStatusCode: status, requestId: "SENSITIVE-request-id" }, $response: { body: "SENSITIVE body" },
    BucketName: "SENSITIVE-bucket-name", ...extra,
  });
}
const env = { DATABASE_BACKUP_S3_REGION: "auto", DATABASE_BACKUP_S3_BUCKET: "SENSITIVE-bucket-name", DATABASE_BACKUP_S3_ACCESS_KEY_ID: "SENSITIVE-access", DATABASE_BACKUP_S3_SECRET_ACCESS_KEY: "SENSITIVE-secret", DATABASE_BACKUP_S3_ENDPOINT: "https://SENSITIVE.r2.example", DATABASE_BACKUP_S3_PREFIX: "staging" } as NodeJS.ProcessEnv;
const photoEnv = { PRODUCT_PHOTO_BACKUP_S3_REGION: "auto", PRODUCT_PHOTO_BACKUP_S3_BUCKET: "SENSITIVE-bucket-name", PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID: "SENSITIVE-access", PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY: "SENSITIVE-secret", PRODUCT_PHOTO_BACKUP_S3_ENDPOINT: "https://SENSITIVE.r2.example" } as NodeJS.ProcessEnv;

describe("classifyStorageError: allowlisted identifiers only", () => {
  it.each([
    [sdkError("SignatureDoesNotMatch", 403), "STORAGE_AUTH_REJECTED", 403, "SignatureDoesNotMatch"],
    [sdkError("InvalidAccessKeyId", 403), "STORAGE_AUTH_REJECTED", 403, "InvalidAccessKeyId"],
    [sdkError("AccessDenied", 403), "STORAGE_AUTH_REJECTED", 403, "AccessDenied"],
    [sdkError("Unknown", 401), "STORAGE_AUTH_REJECTED", 401, "OTHER"],
    [sdkError("NoSuchBucket", 404), "STORAGE_BUCKET_NOT_FOUND", 404, "NoSuchBucket"],
    [sdkError("NotImplemented", 501), "STORAGE_NOT_IMPLEMENTED", 501, "NotImplemented"],
    [sdkError("AuthorizationHeaderMalformed", 400), "STORAGE_BAD_REQUEST", 400, "AuthorizationHeaderMalformed"],
    [sdkError("InvalidArgument", 400), "STORAGE_BAD_REQUEST", 400, "InvalidArgument"],
    [sdkError("NotFound", 404), "STORAGE_OBJECT_NOT_FOUND", 404, "NotFound"],
    [sdkError("InternalError", 500), "STORAGE_SERVER_ERROR", 500, "InternalError"],
    [Object.assign(new Error("getaddrinfo ENOTFOUND SENSITIVE.r2.example"), { code: "ENOTFOUND" }), "STORAGE_ENDPOINT_UNREACHABLE", null, "ENOTFOUND"],
    [Object.assign(new TypeError("Invalid URL SENSITIVE"), { code: "ERR_INVALID_URL" }), "STORAGE_ENDPOINT_UNREACHABLE", null, "TypeError"],
    [sdkError("SENSITIVE-custom-name", undefined), "STORAGE_OTHER", null, "OTHER"],
  ])("%#", (error, code, httpStatus, errorName) => {
    const d = classifyStorageError("STORAGE_UPLOAD", error);
    expect(d).toEqual({ stage: "STORAGE_UPLOAD", code, httpStatus, errorName });
    expect(JSON.stringify(d)).not.toMatch(SENSITIVE);
  });
});

describe("database backup: step-boundary diagnostics through the real S3 repository (no network)", () => {
  const dirs: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
  async function source() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "diag-db-")); dirs.push(dir);
    const sqlite = new Database(path.join(dir, "live.sqlite")); sqlite.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x');");
    return { sqlite, source: { backup: (p: string) => sqlite.backup(p) } };
  }
  const inspector = { inspect(p: string) { const r = checkSqliteIntegrity(p); if (r.integrity !== "ok" || !r.fingerprint) throw new Error("SENSITIVE integrity"); return r.fingerprint; } };
  const failingAt = (command: string, error: unknown) => ({ send: vi.fn(async (c: { constructor: { name: string } }) => {
    if (c.constructor.name === command) throw error;
    if (c.constructor.name === "PutObjectCommand") return {};
    throw sdkError("NotFound", 404);
  }) });

  it("classifies a rejected upload (e.g. wrong secret) without exposing the provider error", async () => {
    const { sqlite, source: src } = await source();
    const repository = createS3CompatibleBackupRepository(readS3CompatibleBackupConfig(env), failingAt("PutObjectCommand", sdkError("SignatureDoesNotMatch", 403)) as never);
    const error = await executeDiagnosedDatabaseBackup({ source: src, repository, inspector, prefix: "staging" }).catch((e: unknown) => e);
    sqlite.close();
    expect(error).toBeInstanceOf(BackupFailedError);
    expect((error as BackupFailedError).diagnostic).toEqual({ stage: "STORAGE_UPLOAD", code: "STORAGE_AUTH_REJECTED", httpStatus: 403, errorName: "SignatureDoesNotMatch" });
    expect(String((error as Error).message)).toBe("Backup failed");
  });

  it("records the FIRST failing step: a head failure after a successful upload is STORAGE_HEAD", async () => {
    const { sqlite, source: src } = await source();
    const repository = createS3CompatibleBackupRepository(readS3CompatibleBackupConfig(env), failingAt("HeadObjectCommand", sdkError("AccessDenied", 403)) as never);
    const error = await executeDiagnosedDatabaseBackup({ source: src, repository, inspector, prefix: "staging" }).catch((e: unknown) => e) as BackupFailedError;
    sqlite.close();
    expect(error.diagnostic).toMatchObject({ stage: "STORAGE_HEAD", code: "STORAGE_AUTH_REJECTED" });
  });

  it("separates local snapshot failures and missing configuration from storage failures", async () => {
    const repository = { upload: vi.fn(), head: vi.fn(), download: vi.fn() };
    const local = await executeDiagnosedDatabaseBackup({ source: { backup: async () => { throw new Error("SENSITIVE disk path /var/data"); } }, repository, inspector, prefix: "p" }).catch((e: unknown) => e) as BackupFailedError;
    expect(local.diagnostic).toEqual({ stage: "LOCAL_SNAPSHOT", code: "LOCAL_SOURCE_FAILED", httpStatus: null, errorName: null });
    expect(repository.upload).not.toHaveBeenCalled();
    for (const missing of ["DATABASE_BACKUP_S3_REGION", "DATABASE_BACKUP_S3_BUCKET", "DATABASE_BACKUP_S3_ACCESS_KEY_ID", "DATABASE_BACKUP_S3_SECRET_ACCESS_KEY"]) {
      const config = await runDatabaseBackup({} as never, { ...env, [missing]: "" }).catch((e: unknown) => e) as BackupFailedError;
      expect(config.diagnostic, missing).toEqual({ stage: "CONFIG", code: "CONFIG_MISSING_OR_INVALID", httpStatus: null, errorName: null });
    }
  });
});

describe("product-photo backup: step-boundary diagnostics", () => {
  const references = (items: unknown[]) => ({ listPage: vi.fn(async () => ({ items, nextCursor: undefined })) });
  const photo = { photoId: "p1", productId: "x", mimeType: "image/webp", locallyOwned: true, mainStorageKey: "SENSITIVE-main.webp", thumbnailStorageKey: "SENSITIVE-thumb.webp" };

  it("an empty catalogue still reaches storage (manifest), so storage/config problems fail it too", async () => {
    const repository = createS3CompatibleProductPhotoBackupRepository(readS3CompatibleProductPhotoBackupConfig(photoEnv), { send: vi.fn(async () => { throw sdkError("SignatureDoesNotMatch", 403); }) } as never);
    const error = await executeDiagnosedProductPhotoBackup({ references: references([]) as never, files: { inspect: vi.fn() }, repository, prefix: "product-photo-backups" }).catch((e: unknown) => e) as BackupFailedError;
    expect(error.diagnostic).toEqual({ stage: "STORAGE_HEAD", code: "STORAGE_AUTH_REJECTED", httpStatus: 403, errorName: "SignatureDoesNotMatch" });
  });

  it("a missing or changed local photo file is LOCAL_FILE, a DB read failure is LOCAL_DB_READ, before any storage call", async () => {
    const repository = { head: vi.fn(), upload: vi.fn(), download: vi.fn() };
    const file = await executeDiagnosedProductPhotoBackup({ references: references([photo]) as never, files: { inspect: vi.fn(async () => { throw new Error("SENSITIVE /var/data/product-photos/x.webp"); }) }, repository, prefix: "p" }).catch((e: unknown) => e) as BackupFailedError;
    expect(file.diagnostic).toEqual({ stage: "LOCAL_FILE", code: "LOCAL_SOURCE_FAILED", httpStatus: null, errorName: null });
    const db = await executeDiagnosedProductPhotoBackup({ references: { listPage: vi.fn(async () => { throw new Error("SENSITIVE sql"); }) } as never, files: { inspect: vi.fn() }, repository, prefix: "p" }).catch((e: unknown) => e) as BackupFailedError;
    expect(db.diagnostic.stage).toBe("LOCAL_DB_READ");
    expect(repository.head).not.toHaveBeenCalled();
    const config = await runProductPhotoBackup({} as never, { ...photoEnv, PRODUCT_PHOTO_BACKUP_S3_REGION: " " }).catch((e: unknown) => e) as BackupFailedError;
    expect(config.diagnostic.code).toBe("CONFIG_MISSING_OR_INVALID");
  });
});

describe("routes: one fixed-shape log line, unchanged generic 503", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it.each([
    ["database", (run: () => Promise<never>) => createDatabaseBackupRouter(run as never), "Database backup or verification failed", "database_backup_failed"],
    ["photo", (run: () => Promise<never>) => createProductPhotoBackupRouter(run), "Product photo backup or verification failed", "product_photo_backup_failed"],
  ])("%s", async (_label, router, body, event) => {
    vi.stubEnv("SCHEDULER_AUTH_TOKEN", "test-scheduler-token");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [failure, expected] of [
      [new BackupFailedError({ stage: "STORAGE_UPLOAD", code: "STORAGE_AUTH_REJECTED", httpStatus: 403, errorName: "SignatureDoesNotMatch" }), { stage: "STORAGE_UPLOAD", code: "STORAGE_AUTH_REJECTED", httpStatus: 403, errorName: "SignatureDoesNotMatch" }],
      [sdkError("SENSITIVE-unclassified", 500), { stage: "VERIFY_OR_WORKSPACE", code: "VERIFICATION_OR_WORKSPACE_FAILED", httpStatus: null, errorName: null }],
    ] as const) {
      log.mockClear();
      const app = express(); app.use("/b", router(() => Promise.reject(failure)));
      const res = await request(app).post("/b").set("Authorization", "Bearer test-scheduler-token");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: body });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]![0]);
      expect(JSON.parse(line)).toEqual({ event, ...expected });
      expect(line).not.toMatch(SENSITIVE);
      expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
    }
  });

  it("logBackupFailure never serialises error properties", () => {
    const lines: string[] = [];
    logBackupFailure("database_backup_failed", sdkError("SignatureDoesNotMatch", 403), (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(SENSITIVE);
  });
});
