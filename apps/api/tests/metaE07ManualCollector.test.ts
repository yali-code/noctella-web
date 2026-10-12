// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { runMetaE07Staging, assertMetaE07ActualDatabaseRuntime } from "../src/scripts/runMetaE07Staging";
import { paidReportingWindow, type PaidCampaignQuery, type PaidCampaignObservation } from "../src/use-cases/ads/paidCampaignCollectorContract";

const query: PaidCampaignQuery = {
  provider: "meta", accountId: "3095361257478763", campaignId: "987654321098765",
  startDate: "2026-10-01", endDate: "2026-10-02",
};
const now = new Date("2026-10-12T12:00:00.000Z");
const env: Record<string, string> = {
  RENDER_SERVICE_NAME: "noctella-staging-api",
  DATABASE_DRIVER: "sqlite", DATABASE_URL: "/var/data/noctella.sqlite",
  DATABASE_BACKUP_S3_BUCKET: "noctella-staging-db-backups",
  DATABASE_BACKUP_S3_PREFIX: "database-backups",
  NOCTELLA_PAID_ADS_PROVIDER: "meta",
  NOCTELLA_PAID_ADS_PREVIEW_ACK: "I_AUTHORIZE_PAID_READ_ONLY",
  NOCTELLA_PAID_ADS_STAGE_WRITE_ACK: "I_AUTHORIZE_STAGING_SNAPSHOT_WRITE",
  NOCTELLA_META_AD_ACCOUNT_ID: query.accountId,
  NOCTELLA_PAID_ADS_CAMPAIGN_ID: query.campaignId,
  NOCTELLA_PAID_ADS_START_DATE: query.startDate,
  NOCTELLA_PAID_ADS_END_DATE: query.endDate,
  NOCTELLA_META_AD_ACCESS_TOKEN: "fixture-not-a-real-provider-token",
  NOCTELLA_E07_STAGING_BACKUP_KEY: "database-backups/noctella-sqlite-20261012T030030974Z-18ab73d08772ce52.sqlite",
};
const backup = {
  mode: "STAGING_META_COLLECTION_PREFLIGHT" as const,
  readyForManualReview: true as const, provider: "meta" as const,
  reportStart: query.startDate, reportEnd: query.endDate,
  databaseWritePerformed: false as const, providerCalled: false as const,
  campaignModified: false as const, spendAuthorized: false as const,
  backupIntegrity: "ok" as const, backupFreshness: "WITHIN_36H" as const,
  backupByteSize: 2514944, backupSha256: "18ab73d08772ce5218a9ccfdbafd478088ce34df6f3a940ec6ece84d44c1ebb1",
  backupVerifiedAt: now.toISOString(), snapshotWritePerformed: false as const,
};
const observation: PaidCampaignObservation = {
  provider: "meta", accountId: query.accountId, campaignId: query.campaignId,
  sourceReference: "meta.ads.graph_v26_insights", currency: "EUR",
  reportingTimeZone: "Europe/Sofia",
  window: paidReportingWindow(query, "Europe/Sofia"),
  spendEur: 6.25, impressions: 700, clicks: 12,
  providerReportedConversions: null, providerReportedConversionValueEur: null, warnings: [],
};
function fakes(o = observation) {
  const verifyBackup = vi.fn(async () => backup);
  const fetchCampaign = vi.fn(async () => o);
  const persist = vi.fn(async () => ({
    run: { id: "synthetic-test-only-run", status: "completed" },
    replayed: false, spendAuthorized: false as const,
  }));
  return { verifyBackup, client: { provider: "meta" as const, fetchCampaign }, persist, fetchCampaign };
}
describe("ADS-009M Meta E07 manual staging collection orchestration", () => {
  it("defaults to local + R2-only preflight with no Meta calls or SQLite open", async () => {
    const deps = fakes();
    const result = await runMetaE07Staging(env, deps, now);
    expect(result.operation).toBe("preflight");
    expect(result.spendAuthorized).toBe(false);
    expect(deps.verifyBackup).toHaveBeenCalledOnce();
    expect(deps.fetchCampaign).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(env.NOCTELLA_META_AD_ACCESS_TOKEN);
  });
  it("preview may read campaign observation only after backup but never stores", async () => {
    const deps = fakes();
    const result = await runMetaE07Staging({ ...env, NOCTELLA_E07_OPERATION: "preview" }, deps, now);
    expect(result.status).toBe("PREVIEW_ONLY");
    expect(result.databaseWritePerformed).toBe(false);
    expect(deps.verifyBackup).toHaveBeenCalledOnce();
    expect(deps.fetchCampaign).toHaveBeenCalledOnce();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(env.NOCTELLA_META_AD_ACCESS_TOKEN);
  });
  it("write requires distinct one-time acknowledgement before R2, Meta or SQLite", async () => {
    const deps = fakes();
    await expect(runMetaE07Staging({ ...env, NOCTELLA_E07_OPERATION: "write" }, deps, now))
      .rejects.toThrow("not authorized");
    expect(deps.verifyBackup).not.toHaveBeenCalled();
    expect(deps.fetchCampaign).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it("write can reach only injected synthetic store after verified backup and observed real metrics", async () => {
    const deps = fakes();
    const result = await runMetaE07Staging({
      ...env, NOCTELLA_E07_OPERATION: "write",
      NOCTELLA_E07_ONE_TIME_WRITE_ACK: "I_AUTHORIZE_ONE_TIME_STAGING_SNAPSHOT_WRITE",
    }, deps, now);
    expect(result.status).toBe("STORED");
    expect(result.spendAuthorized).toBe(false);
    expect(deps.verifyBackup).toHaveBeenCalledOnce();
    expect(deps.fetchCampaign).toHaveBeenCalledOnce();
    expect(deps.persist).toHaveBeenCalledOnce();
  });
  it("denies a fake-success backup verifier if the operator scope is production", async () => {
    const deps = fakes();
    await expect(runMetaE07Staging({
      ...env, RENDER_SERVICE_NAME: "noctella-production-api", NOCTELLA_E07_OPERATION: "preview",
    }, deps, now)).rejects.toThrow(/staging identity/);
    expect(deps.verifyBackup).not.toHaveBeenCalled();
    expect(deps.fetchCampaign).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it("rejects actual production or divergent process env before db/client import", () => {
    const scope = {
      ...env, NOCTELLA_E07_OPERATION: "write",
      NOCTELLA_E07_ONE_TIME_WRITE_ACK: "I_AUTHORIZE_ONE_TIME_STAGING_SNAPSHOT_WRITE",
    };
    expect(() => assertMetaE07ActualDatabaseRuntime(scope, scope, now)).not.toThrow();
    expect(() => assertMetaE07ActualDatabaseRuntime(scope, {
      ...scope, RENDER_SERVICE_NAME: "noctella-production-api",
    }, now)).toThrow(/staging identity/);
    expect(() => assertMetaE07ActualDatabaseRuntime(scope, {
      ...scope, NOCTELLA_META_AD_ACCOUNT_ID: "11111111111",
    }, now)).toThrow(/runtime differs/);
    expect(() => assertMetaE07ActualDatabaseRuntime(scope, {
      ...scope, DATABASE_URL: "/tmp/other.sqlite",
    }, now)).toThrow(/staging identity/);
    expect(() => assertMetaE07ActualDatabaseRuntime(scope, {
      ...scope, NOCTELLA_E07_ONE_TIME_WRITE_ACK: "",
    }, now)).toThrow(/runtime differs/);
  });
  it("missing or failing backup gate blocks Meta reads and SQLite entirely", async () => {
    const deps = fakes();
    deps.verifyBackup.mockRejectedValueOnce(new Error("R2 failure"));
    await expect(runMetaE07Staging({ ...env, NOCTELLA_E07_OPERATION: "preview" }, deps, now))
      .rejects.toThrow("R2 failure");
    expect(deps.fetchCampaign).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it("empty provider report remains unknown, never written as zero", async () => {
    const deps = fakes({ ...observation, spendEur: null, impressions: null, clicks: null, warnings: ["NO_CAMPAIGN_REPORT"] });
    const result = await runMetaE07Staging({
      ...env, NOCTELLA_E07_OPERATION: "write",
      NOCTELLA_E07_ONE_TIME_WRITE_ACK: "I_AUTHORIZE_ONE_TIME_STAGING_SNAPSHOT_WRITE",
    }, deps, now);
    expect(result.status).toBe("NO_CAMPAIGN_REPORT");
    expect(result.databaseWritePerformed).toBe(false);
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it("mismatched account provenance fails before SQLite opens", async () => {
    const deps = fakes({ ...observation, accountId: "99999999999" });
    await expect(runMetaE07Staging({ ...env, NOCTELLA_E07_OPERATION: "preview" }, deps, now))
      .rejects.toThrow(/mismatch/);
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it("provider account-local reporting day must be completed", async () => {
    const laObservation = {
      ...observation, reportingTimeZone: "America/Los_Angeles",
      window: paidReportingWindow(query, "America/Los_Angeles"),
    };
    const deps = fakes(laObservation);
    // UTC date has finished, but Los Angeles 2026-10-02 has not.
    await expect(runMetaE07Staging({ ...env, NOCTELLA_E07_OPERATION: "preview" },
      deps, new Date("2026-10-03T00:00:01.000Z"))).rejects.toThrow(/not completed/);
    expect(deps.persist).not.toHaveBeenCalled();
  });
  for (const [key, value] of [
    ["NOCTELLA_E07_OPERATION", "deploy"],
    ["NOCTELLA_META_AD_ACCESS_TOKEN", ""],
  ] as const) {
    it("denies invalid "+key+" before calling R2 or Meta", async () => {
      const deps = fakes();
      await expect(runMetaE07Staging({ ...env, NOCTELLA_E07_OPERATION: "preview", [key]: value },
        deps, now)).rejects.toThrow();
      expect(deps.verifyBackup).not.toHaveBeenCalled();
      expect(deps.fetchCampaign).not.toHaveBeenCalled();
      expect(deps.persist).not.toHaveBeenCalled();
    });
  }
});
