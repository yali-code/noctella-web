// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseBackupObjectMetadata, DatabaseBackupRepository } from "../src/repositories/database-backup/types";
import { createDatabaseRestoreVerificationUseCase } from "../src/use-cases/database-backup/useCases";
import { checkSqliteIntegrity } from "../src/services/databaseMigrationFoundation";

/**
 * Stage 1 staging-isolation audit (ADS-009C): SOURCE-LEVEL invariants of the checked-in Render
 * Blueprint and the restore-verify path. These prove what the repository declares; they are NOT
 * runtime evidence - dashboard overrides and operator-supplied values must be attested separately.
 */
const blueprint = () => readFile(path.resolve(__dirname, "../../../render.yaml"), "utf8");
function services(yaml: string) {
  const body = yaml.slice(yaml.indexOf("services:"));
  return body.split(/\n(?=  - type: )/).slice(1).map((block) => ({
    type: /^  - type: (\S+)/.exec(block)![1]!,
    name: /\n    name: (\S+)/.exec(block)![1]!,
    block,
  }));
}
/** The env entry for `key` inside a service block (up to the next `- key:`). */
function envEntry(block: string, key: string) {
  const at = block.indexOf(`- key: ${key}\n`) >= 0 ? block.indexOf(`- key: ${key}\n`) : block.indexOf(`- key: ${key}\r\n`);
  if (at < 0) return null;
  const rest = block.slice(at + 1);
  const next = rest.search(/\n\s*- key: /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Render Blueprint staging isolation invariants (source only)", () => {
  it("declares only staging services and a single staging disk on the staging API", async () => {
    const all = services(await blueprint());
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const s of all) expect(s.name).toMatch(/^noctella-staging-/);
    const withDisk = all.filter((s) => /\n    disk:/.test(s.block));
    expect(withDisk.map((s) => s.name)).toEqual(["noctella-staging-api"]);
    expect(withDisk[0]!.block).toMatch(/\n      name: noctella-staging-data\r?\n/);
  });

  it("binds every cron's API target and scheduler token to the staging API service, never a literal", async () => {
    const crons = services(await blueprint()).filter((s) => s.type === "cron");
    expect(crons.length).toBeGreaterThanOrEqual(3);
    for (const cron of crons) {
      for (const key of ["API_HOSTPORT", "SCHEDULER_AUTH_TOKEN"]) {
        const entry = envEntry(cron.block, key);
        expect(entry, `${cron.name} ${key}`).not.toBeNull();
        expect(entry).toMatch(/fromService:\s*\r?\n\s*name: noctella-staging-api\r?\n\s*type: web/);
        expect(entry).not.toMatch(/\bvalue:/);
      }
      // Crons are thin HTTP triggers: no disk, database path or storage credentials.
      expect(cron.block).not.toMatch(/disk:|DATABASE_URL|_S3_(BUCKET|ENDPOINT|ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
    }
  });

  it("never commits storage destinations or credentials, and the scheduler token is generated per service", async () => {
    const api = services(await blueprint()).find((s) => s.name === "noctella-staging-api")!;
    for (const key of ["DATABASE_BACKUP_S3_ENDPOINT", "DATABASE_BACKUP_S3_BUCKET", "DATABASE_BACKUP_S3_ACCESS_KEY_ID", "DATABASE_BACKUP_S3_SECRET_ACCESS_KEY",
      "PRODUCT_PHOTO_BACKUP_S3_ENDPOINT", "PRODUCT_PHOTO_BACKUP_S3_BUCKET", "PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID", "PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY"]) {
      expect(envEntry(api.block, key), key).toMatch(/sync: false/);
    }
    expect(envEntry(api.block, "SCHEDULER_AUTH_TOKEN")).toMatch(/generateValue: true/);
    // Known limitation recorded by the audit: the committed prefixes carry no environment marker,
    // so bucket separation must be attested by the operator (see ADS-009C).
    expect(envEntry(api.block, "DATABASE_BACKUP_S3_PREFIX")).toMatch(/value: database-backups/);
  });

  it("points every staging origin and API base URL at *.staging.noctella.com", async () => {
    const yaml = await blueprint();
    const urls = [...yaml.matchAll(/value: (https:\/\/[^\s]+)/g)].map((m) => new URL(m[1]!).hostname);
    expect(urls.length).toBeGreaterThan(0);
    for (const host of urls) expect(host).toMatch(/\.staging\.noctella\.com$/);
    expect(yaml).toMatch(/key: COOKIE_DOMAIN\r?\n\s*value: \.staging\.noctella\.com/);
  });
});

describe("db:restore-verify cannot write the live database, migrations or the backup bucket", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

  it("never uploads, downloads only into a fresh OS temp directory that is removed, and leaves the live file untouched", async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), "isolation-audit-")); dirs.push(work);
    const live = path.join(work, "live.sqlite");
    const sqlite = new Database(live); sqlite.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('live');"); sqlite.close();
    const bytes = await readFile(live);
    const meta: DatabaseBackupObjectMetadata = { objectKey: "database-backups/noctella-sqlite-20261011T000000Z-0123456789abcdef.sqlite", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: "2026-10-11T00:00:00.000Z" };
    const downloads: string[] = [];
    const upload = vi.fn(async () => { throw new Error("restore verification must never upload"); });
    const repository: DatabaseBackupRepository = {
      upload, head: async () => meta,
      download: async (_key, destination) => { downloads.push(destination); await copyFile(live, destination); return bytes.length; },
    };
    const inspector = { inspect(file: string) { const r = checkSqliteIntegrity(file); if (r.integrity !== "ok" || !r.fingerprint) throw new Error("bad"); return r.fingerprint; } };
    const before = await stat(live);
    await expect(createDatabaseRestoreVerificationUseCase(repository, inspector).execute(meta.objectKey)).resolves.toMatchObject({ integrity: "ok" });
    expect(upload).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(1);
    expect(path.dirname(downloads[0]!).startsWith(path.join(os.tmpdir(), "noctella-db-restore-verification-"))).toBe(true);
    expect(existsSync(path.dirname(downloads[0]!))).toBe(false);
    expect((await stat(live)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(live)).toEqual(bytes);
  });

  it("the restore-verify CLI module graph never loads the live database client (no live open, no ensureSchema)", async () => {
    vi.resetModules();
    vi.doMock("../src/db/client", () => { throw new Error("db/client must not be imported by db:restore-verify"); });
    try {
      await expect(import("../src/scripts/verifyDatabaseRestore")).resolves.toBeDefined();
      await expect(import("../src/services/databaseBackup")).resolves.toBeDefined();
    } finally {
      vi.doUnmock("../src/db/client");
    }
  });
});
