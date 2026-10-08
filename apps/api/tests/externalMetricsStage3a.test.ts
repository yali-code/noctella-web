// @vitest-environment node
process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getProductAnalyticsHistory, runProfitabilitySnapshot } from "../src/services/analyticsSnapshots";
import { encryptCredential } from "../src/services/credentialEncryption";
import { runExternalAnalyticsCollection } from "../src/services/externalAnalytics";
import { ExternalCollectorError, type ExternalAnalyticsCollector, type ExternalCollectionResult } from "../src/use-cases/analytics/externalMetrics";
import { productMetricHistoryQuerySchema } from "../src/use-cases/analytics/profitabilitySnapshots";

/**
 * Analytics Stage 3A: external metrics ingestion foundation, exercised with a fake collector
 * (never a live provider). Reuses analytics_runs / analytics_metric_snapshots.
 */

const NOW = new Date("2026-10-01T15:30:00.000Z");
const TOKEN = "secret-provider-token-value";

function seededDb() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema }) as any;
  const t = "2026-01-01T00:00:00.000Z";
  db.insert(schema.marketplaceConnections).values({ id: "conn-1", channel: "ebay", accountLabel: "main", status: "connected", encryptedAccessToken: encryptCredential(TOKEN) }).run();
  db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Clock", slug: "clock", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
  db.insert(schema.externalListings).values({ id: "el-1", productId: "p-1", channel: "ebay", connectionId: "conn-1", externalListingId: "L-100", externalStatus: "active", payloadSnapshot: "{}", publishedAt: t }).run();
  return { sqlite, db };
}

const WINDOW = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-30T23:59:59.000Z" };
function result(overrides: Partial<ExternalCollectionResult> = {}): ExternalCollectionResult {
  return {
    platform: "ebay",
    sourceReference: "fake.traffic_report.v1",
    observedAt: WINDOW.end,
    window: WINDOW,
    observations: [
      { entityType: "listing", externalEntityId: "L-100", metricKey: "listing_impressions", providerMetric: "IMPRESSIONS_TOTAL", value: 1200, unit: "count", windowSemantics: "fixed_range" },
      { entityType: "listing", externalEntityId: "L-100", metricKey: "listing_views", providerMetric: "VIEWS_TOTAL", value: null, unit: "count", windowSemantics: "fixed_range" },
      { entityType: "listing", externalEntityId: "L-999", metricKey: "listing_impressions", providerMetric: "IMPRESSIONS_TOTAL", value: 40, unit: "count", windowSemantics: "fixed_range" },
    ],
    warnings: [],
    ...overrides,
  };
}
const collector = (outcome: ExternalCollectionResult | Error): ExternalAnalyticsCollector & { collect: ReturnType<typeof vi.fn> } => ({
  platform: "ebay",
  collect: vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome; }),
});
const rows = (sqlite: Database.Database) => sqlite.prepare("SELECT * FROM analytics_metric_snapshots WHERE source_type = 'external_platform' ORDER BY scope_id, metric_key").all() as any[];

describe("Stage 3A external metrics ingestion", () => {
  it("normalizes observations with provenance, maps listings via external_listings, keeps unknown as NULL", async () => {
    const { sqlite, db } = seededDb();
    const fake = collector(result());
    const { run, replayed, warnings } = await runExternalAnalyticsCollection(db, fake, { now: NOW, collectedAt: NOW });
    expect(replayed).toBe(false);
    expect(fake.collect).toHaveBeenCalledWith({ connectionId: "conn-1", accessToken: TOKEN, now: NOW });
    expect(run).toMatchObject({ status: "completed", sourceType: "external_platform", sourceReference: "fake.traffic_report.v1", observedAt: WINDOW.end, metricCount: 3 });
    expect(warnings).toEqual(["UNMAPPED_LISTING:ebay:L-999"]);

    const stored = rows(sqlite);
    expect(stored.map((r) => [r.scope_type, r.scope_id, r.metric_namespace, r.metric_key, r.numeric_value, r.value_state])).toEqual([
      ["external_listing", "ebay:L-100", "ebay", "listing_impressions", 1200, "known"],
      ["external_listing", "ebay:L-100", "ebay", "listing_views", null, "unknown"],
      ["external_listing", "ebay:L-999", "ebay", "listing_impressions", 40, "known"],
    ]);
    for (const r of stored) expect(r).toMatchObject({ run_id: run.id, observed_at: WINDOW.end, collected_at: NOW.toISOString(), unit: "count" });
    expect(JSON.parse(stored[0].metadata_json)).toEqual({ platform: "ebay", connectionId: "conn-1", externalListingId: "L-100", productId: "p-1", providerMetric: "IMPRESSIONS_TOTAL", windowSemantics: "fixed_range", window: WINDOW });
    expect(JSON.parse(stored[2].metadata_json).productId).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
  });

  it("a retry of the same platform/connection/window replays without duplicating snapshots", async () => {
    const { sqlite, db } = seededDb();
    const first = await runExternalAnalyticsCollection(db, collector(result()), { now: NOW });
    const retry = await runExternalAnalyticsCollection(db, collector(result()), { now: new Date("2026-10-01T18:00:00.000Z") });
    expect(retry).toMatchObject({ replayed: true, run: { id: first.run.id } });
    expect(rows(sqlite)).toHaveLength(3);
    const nextWindow = await runExternalAnalyticsCollection(db, collector(result({ observedAt: "2026-10-31T23:59:59.000Z", window: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T23:59:59.000Z" } })), { now: NOW });
    expect(nextWindow.replayed).toBe(false);
    expect(rows(sqlite)).toHaveLength(6);
  });

  it.each([
    ["authentication", new ExternalCollectorError("authentication", "Provider rejected the token")],
    ["rate_limit", new ExternalCollectorError("rate_limit", "Provider rate limit")],
    ["temporary (untyped error)", new Error(`boom ${TOKEN}`)],
  ])("a %s failure records a failed run, writes no metrics and leaks no token", async (_label, error) => {
    const { sqlite, db } = seededDb();
    await expect(runExternalAnalyticsCollection(db, collector(error), { now: NOW })).rejects.toBeInstanceOf(ExternalCollectorError);
    expect(rows(sqlite)).toHaveLength(0);
    const runs = sqlite.prepare("SELECT * FROM analytics_runs").all() as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(String(runs[0].error)).not.toContain(TOKEN);
  });

  it("malformed provider data (non-finite value / unknown window) is rejected whole, never partially stored", async () => {
    const { sqlite, db } = seededDb();
    const bad = result({ observations: [{ ...result().observations[0]!, value: Number.NaN }] });
    await expect(runExternalAnalyticsCollection(db, collector(bad), { now: NOW })).rejects.toMatchObject({ kind: "malformed_payload" });
    const badWindow = result({ observations: [{ ...result().observations[0]!, windowSemantics: "weekly" as any }] });
    await expect(runExternalAnalyticsCollection(db, collector(badWindow), { now: NOW })).rejects.toMatchObject({ kind: "malformed_payload" });
    expect(rows(sqlite)).toHaveLength(0);
  });

  it("without a connected account no collector call is made", async () => {
    const { db } = seededDb();
    db.update(schema.marketplaceConnections).set({ status: "disconnected" }).run();
    const fake = collector(result());
    await expect(runExternalAnalyticsCollection(db, fake, { now: NOW })).rejects.toMatchObject({ kind: "not_connected" });
    expect(fake.collect).not.toHaveBeenCalled();
  });

  it("internal snapshots are unaffected, and mapped external metrics appear in the product history", async () => {
    const { sqlite, db } = seededDb();
    runProfitabilitySnapshot(db, { now: NOW, collectedAt: NOW });
    const internalBefore = sqlite.prepare("SELECT * FROM analytics_metric_snapshots WHERE source_type = 'internal_deterministic' ORDER BY rowid").all();
    await runExternalAnalyticsCollection(db, collector(result()), { now: NOW });
    expect(sqlite.prepare("SELECT * FROM analytics_metric_snapshots WHERE source_type = 'internal_deterministic' ORDER BY rowid").all()).toEqual(internalBefore);
    const history = getProductAnalyticsHistory(db, "p-1", productMetricHistoryQuerySchema.parse({ metricKey: "listing_impressions" }));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ scopeType: "external_listing", scopeId: "ebay:L-100", metricNamespace: "ebay", numericValue: 1200, sourceType: "external_platform" });
  });
});
