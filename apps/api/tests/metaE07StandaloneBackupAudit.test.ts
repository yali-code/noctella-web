// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { verifyMetaE07BackupOnly, verifyMetaE07BackupPreflight } from "../src/scripts/verifyMetaE07BackupPreflight";
import type { verifyRemoteDatabaseBackup } from "../src/services/databaseBackup";

const key = "database-backups/noctella-sqlite-20261012T030030974Z-18ab73d08772ce52.sqlite";
const stage: Record<string, string> = {
  RENDER_SERVICE_NAME: "noctella-staging-api",
  DATABASE_DRIVER: "sqlite",
  DATABASE_URL: "/var/data/noctella.sqlite",
  DATABASE_BACKUP_S3_BUCKET: "noctella-staging-db-backups",
  DATABASE_BACKUP_S3_PREFIX: "database-backups",
  NOCTELLA_E07_STAGING_BACKUP_KEY: key,
};
const now = new Date("2026-10-12T12:00:00.000Z");
const artifact = {
  objectKey: key,
  byteSize: 2514944,
  sha256: "18ab73d08772ce5218a9ccfdbafd478088ce34df6f3a940ec6ece84d44c1ebb1",
  createdAt: "2026-10-12T03:00:30.000Z",
  integrity: "ok" as const,
};
const fake = (value = artifact) =>
  vi.fn(async (_key: string, _env?: NodeJS.ProcessEnv) => value) as unknown as typeof verifyRemoteDatabaseBackup;

describe("ADS-009O E07 independent R2 audit: no campaign, read-only", () => {
  it("checks staging R2 backup without fake campaign, token, or write acknowledgement", async () => {
    const verify = fake();
    const result = await verifyMetaE07BackupOnly(stage, verify, now);
    expect(result).toMatchObject({
      mode: "STAGING_E07_R2_BACKUP_AUDIT",
      backupIntegrity: "ok",
      backupFreshness: "WITHIN_36H",
      objectKey: key,
      databaseWritePerformed: false,
      snapshotWritePerformed: false,
      providerCalled: false,
      campaignModified: false,
      spendAuthorized: false,
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(vi.mocked(verify).mock.calls[0]?.[0]).toBe(key);
  });

  for (const [name, badValue] of [
    ["RENDER_SERVICE_NAME", "noctella-production-api"],
    ["RENDER_SERVICE_NAME", ""],
    ["DATABASE_DRIVER", "postgres"],
    ["DATABASE_URL", "/tmp/not-staging.sqlite"],
    ["DATABASE_BACKUP_S3_BUCKET", "noctella-production-db-backups"],
    ["DATABASE_BACKUP_S3_PREFIX", "production/database-backups"],
  ] as const) {
    it("rejects bad " + name + " before any R2 request", async () => {
      const verify = fake();
      await expect(verifyMetaE07BackupOnly({ ...stage, [name]: badValue }, verify, now))
        .rejects.toThrow("denied");
      expect(verify).not.toHaveBeenCalled();
    });
  }

  for (const badKey of ["", "../production.sqlite", "other/noctella-sqlite-20261012.sqlite"]) {
    it("rejects malformed backup key before R2: " + badKey, async () => {
      const verify = fake();
      await expect(verifyMetaE07BackupOnly({
        ...stage, NOCTELLA_E07_STAGING_BACKUP_KEY: badKey,
      }, verify, now)).rejects.toThrow("denied");
      expect(verify).not.toHaveBeenCalled();
    });
  }

  it("rejects stale, future, mismatched and corrupt backup metadata", async () => {
    for (const patch of [
      { createdAt: "2026-10-10T00:00:00.000Z" },
      { createdAt: "2026-10-13T00:00:00.000Z" },
      { integrity: "bad" as "ok" },
      { objectKey: "database-backups/another.sqlite" },
      { byteSize: 0 },
      { sha256: "not-a-valid-sha" },
    ]) {
      await expect(verifyMetaE07BackupOnly(stage, fake({ ...artifact, ...patch }), now))
        .rejects.toThrow("denied");
    }
  });

  it("keeps the existing full Meta write-gate requirement unchanged", async () => {
    const verify = fake();
    await expect(verifyMetaE07BackupPreflight(stage, verify, now))
      .rejects.toThrow("denied");
    expect(verify).not.toHaveBeenCalled();
  });
});
