// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import type { DbClient } from "../src/db/client";
import * as schema from "../src/db/schema";
import { readPaidCampaignReport } from "../src/use-cases/ads/adsPaidCampaignRead";

/**
 * ADS-006E: exercise the real Drizzle/SQLite SELECT against the repository's
 * authoritative schema, not a stubbed .all() or invented production fixture.
 * Never contacts providers, production SQLite or production credentials.
 */
const ID = "123456789";
const START = "2026-10-01T00:00:00.000Z";
const END = "2026-10-08T00:00:00.000Z";
const COLLECTED = "2026-10-09T00:00:00.000Z";
const REF = "meta.ads.insights";
type TestDb = { sqlite: Database.Database; db: DbClient };
function openMemory(): TestDb {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema }) as DbClient;
  return { sqlite, db };
}
function insertRun(
  sqlite: Database.Database,
  id = "run-meta-1",
  status = "completed",
  sourceType = "external_platform",
  sourceRef = REF,
): void {
  sqlite.prepare(`
    INSERT INTO analytics_runs (
      id, run_type, source_type, source_reference, idempotency_key,
      status, observed_at, started_at, completed_at, metric_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, "external_meta_ads_metrics", sourceType, sourceRef,
    `ads-fixture:${id}`, status, END, COLLECTED, COLLECTED, 5);
}
function putMetric(
  sqlite: Database.Database, metricKey: string,
  amount: number | null, unit: "eur" | "count", opts: {
    runId?: string;
    scopeId?: string;
    sourceType?: string;
    sourceReference?: string;
    windowStart?: string;
    observedAt?: string;
    metadataOverride?: string | null;
  } = {},
): void {
  const observedAt = opts.observedAt ?? END;
  const metadata = opts.metadataOverride === undefined
    ? JSON.stringify({
      paidAdsSource: true, provider: "meta", campaignId: ID, currency: "EUR",
      windowSemantics: "fixed_range", window: {start: opts.windowStart ?? START, end: observedAt},
    })
    : opts.metadataOverride;
  sqlite.prepare(`
    INSERT INTO analytics_metric_snapshots (
      id, run_id, scope_type, scope_id, metric_namespace, metric_key,
      numeric_value, text_value, value_state, unit, source_type,
      source_reference, observed_at, collected_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`fixture-${metricKey}-${observedAt}`, opts.runId ?? "run-meta-1",
    "external_ad_campaign", opts.scopeId ?? `paid_meta:${ID}`, "paid_meta", metricKey,
    amount, null, amount === null ? "unknown" : "known", unit,
    opts.sourceType ?? "external_platform", opts.sourceReference ?? REF, observedAt,
    COLLECTED, metadata);
}
function completeWindow(sqlite: Database.Database): void {
  putMetric(sqlite, "paid_spend_eur", 10, "eur");
  putMetric(sqlite, "paid_impressions", 1200, "count");
  putMetric(sqlite, "paid_clicks", 25, "count");
  putMetric(sqlite, "paid_provider_conversions", null, "count");
  putMetric(sqlite, "paid_provider_conversion_value_eur", null, "eur");
}

describe("ADS-006E paid reporting using real SQLite schema", () => {
  it("returns NOT_COLLECTED for a real empty database, without inserting records", async () => {
    const {sqlite, db} = openMemory();
    try {
      const before = sqlite.totalChanges;
      const result = await readPaidCampaignReport(db, "meta", ID);
      expect(result.status).toBe("NOT_COLLECTED");
      expect(result.evidence).toBeNull();
      expect(result.spendAuthorized).toBe(false);
      expect(sqlite.totalChanges).toBe(before);
    } finally { sqlite.close(); }
  });
  it("reads five strictly scoped, completed observations with no invented marketplace sale", async () => {
    const {sqlite, db} = openMemory();
    try {
      insertRun(sqlite);
      completeWindow(sqlite);
      const before = sqlite.totalChanges;
      const result = await readPaidCampaignReport(db, "meta", ID);
      expect(result.status).toBe("REPORT_AVAILABLE");
      expect(result.evidence?.spendEur).toBe(10);
      expect(result.evidence?.impressions).toBe(1200);
      expect(result.evidence?.reportedRoas).toBeNull();
      expect(result.evidence?.attributedMarketplaceRevenueEur).toBeNull();
      expect(result.advice?.spendAuthorized).toBe(false);
      expect(result.marketplaceAttributionVerified).toBe(false);
      expect(sqlite.totalChanges).toBe(before);
    } finally { sqlite.close(); }
  });
  it("exposes an orphan snapshot as UNTRUSTED, not as falsely NOT_COLLECTED", async () => {
    const {sqlite, db} = openMemory();
    try {
      putMetric(sqlite, "paid_spend_eur", 10, "eur", {runId: "nonexistent-run"});
      const result = await readPaidCampaignReport(db, "meta", ID);
      expect(result.status).toBe("UNTRUSTED_EVIDENCE");
      expect(result.evidence).toBeNull();
    } finally { sqlite.close(); }
  });
  it("rejects mismatched analytics run source and incomplete run status", async () => {
    for (const [status, sourceType, sourceRef] of [
      ["failed", "external_platform", REF],
      ["completed", "internal_calculation", REF],
      ["completed", "external_platform", "organic.pinterest.metrics"],
    ] as const) {
      const {sqlite, db} = openMemory();
      try {
        insertRun(sqlite, "run-meta-1", status, sourceType, sourceRef);
        putMetric(sqlite, "paid_spend_eur", 10, "eur");
        const result = await readPaidCampaignReport(db, "meta", ID);
        expect(result.status).toBe("UNTRUSTED_EVIDENCE");
        expect(result.evidence).toBeNull();
      } finally { sqlite.close(); }
    }
  });
  it("does not read organic social observations, even with a matching metric key", async () => {
    const {sqlite, db} = openMemory();
    try {
      insertRun(sqlite);
      sqlite.prepare(`
        INSERT INTO analytics_metric_snapshots (
          id, run_id, scope_type, scope_id, metric_namespace, metric_key,
          numeric_value, value_state, unit, source_type,
          source_reference, observed_at, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("organic-1", "run-meta-1", "external_media",
        "instagram:123456789", "instagram", "paid_spend_eur",
        99, "known", "eur", "external_platform", REF, END, COLLECTED);
      const result = await readPaidCampaignReport(db, "meta", ID);
      expect(result.status).toBe("NOT_COLLECTED");
    } finally { sqlite.close(); }
  });
});
