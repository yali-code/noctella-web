// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTestDb } from "./testDb";
import { createSqliteAnalyticsSnapshotRepository } from "../src/repositories/analytics/analyticsSnapshotsSqlite";
import { analyzePaidCampaignWindows, derivePaidRates, readPaidCampaignIntelligence, type PaidWindowMetrics } from "../src/use-cases/ads/adsIntelligence";

/** ADS-007: synthetic fixtures only; no provider call, no production data. */
const day = (d: string) => `2026-${d}T00:00:00.000Z`;
const win = (start: string, end: string, m: Partial<PaidWindowMetrics> = {}): PaidWindowMetrics => ({
  period: { start: day(start), end: day(end) }, sourceReference: "meta.ads.graph_v26_insights",
  spendEur: 70, impressions: 7000, clicks: 140, providerReportedConversions: null, providerReportedConversionValueEur: null, ...m,
});
// Four consecutive 7-day windows, newest last.
const history = (latest: Partial<PaidWindowMetrics> = {}) => [
  win("09-09", "09-16"), win("09-16", "09-23"), win("09-23", "09-30"), win("09-30", "10-07", latest),
];

describe("ADS-007 derived paid rates", () => {
  it("computes CPC, CPM, CTR and spend/day only from known, non-zero denominators", () => {
    expect(derivePaidRates(win("09-30", "10-07"))).toEqual({ days: 7, spendEurPerDay: 10, cpcEur: 0.5, cpmEur: 10, ctr: 0.02, costPerProviderConversionEur: null, gaps: ["PROVIDER_CONVERSIONS_NOT_COLLECTED"] });
    expect(derivePaidRates(win("09-30", "10-07", { clicks: 0, impressions: null, spendEur: null }))).toMatchObject({
      spendEurPerDay: null, cpcEur: null, cpmEur: null, ctr: null, gaps: ["SPEND_UNKNOWN", "IMPRESSIONS_UNKNOWN", "NO_CLICKS", "PROVIDER_CONVERSIONS_NOT_COLLECTED"],
    });
    expect(derivePaidRates(win("09-30", "10-07", { providerReportedConversions: 4 })).costPerProviderConversionEur).toBe(17.5);
  });
});

describe("ADS-007 campaign analysis (advisory only)", () => {
  it("is NOT_COLLECTED without evidence and never invents zero spend", () => {
    const out = analyzePaidCampaignWindows("meta", "120210000000000001", []);
    expect(out).toMatchObject({ status: "NOT_COLLECTED", windows: [], trend: null, anomalies: [], currency: "EUR" });
    expect(out.recommendations.map((r) => r.code)).toEqual(["COLLECT_MORE_EVIDENCE"]);
  });

  it("continues monitoring a stable campaign and reports per-day trends", () => {
    const out = analyzePaidCampaignWindows("meta", "120210000000000001", history());
    expect(out.status).toBe("ANALYSED");
    expect(out.anomalies).toEqual([]);
    expect(out.recommendations.map((r) => r.code)).toEqual(["CONTINUE_MONITORING"]);
    expect(out.trend).toMatchObject({ basis: "PER_DAY", spendPerDayChange: 0, ctrChange: 0, cpcChange: 0, latestPeriod: { start: day("09-30") } });
  });

  it("flags spend spike, CTR drop and CPC spike against the campaign's own baseline", () => {
    const spike = analyzePaidCampaignWindows("meta", "1", history({ spendEur: 210 }));
    // Spend/day 30 vs baseline 10 EUR; CPC 1.50 vs 0.50 EUR at 140 clicks.
    expect(spike.anomalies.map((a) => a.code)).toEqual(["SPEND_SPIKE", "CPC_SPIKE"]);
    expect(spike.recommendations.map((r) => r.code)).toEqual(["INVESTIGATE_SPEND_SPIKE", "REVIEW_BID_AND_COMPETITION"]);
    const ctr = analyzePaidCampaignWindows("meta", "1", history({ clicks: 60, spendEur: 30 }));
    expect(ctr.anomalies.map((a) => a.code)).toEqual(["CTR_DROP"]);
    expect(ctr.recommendations.map((r) => r.code)).toEqual(["REVIEW_CREATIVE_AND_TARGETING"]);
  });

  it("needs enough history and volume before flagging anything", () => {
    const short = analyzePaidCampaignWindows("meta", "1", [win("09-23", "09-30"), win("09-30", "10-07", { spendEur: 700 })]);
    expect(short.anomalies).toEqual([]);
    expect(short.trend?.spendPerDayChange).toBe(9);
    expect(short.recommendations.map((r) => r.code)).toEqual(["COLLECT_MORE_EVIDENCE"]);
    const tiny = analyzePaidCampaignWindows("meta", "1", history({ impressions: 300, clicks: 1 }));
    expect(tiny.anomalies.map((a) => a.code)).not.toContain("CTR_DROP");
  });

  it("treats contradictory delivery data as a data-quality problem, not performance", () => {
    for (const [latest, code] of [
      [{ spendEur: 12, impressions: 0, clicks: 0 }, "SPEND_WITHOUT_DELIVERY"],
      [{ spendEur: 0, impressions: 900, clicks: 4 }, "DELIVERY_WITHOUT_SPEND"],
      [{ impressions: 10, clicks: 50 }, "CLICKS_EXCEED_IMPRESSIONS"],
    ] as const) {
      const out = analyzePaidCampaignWindows("meta", "1", history(latest));
      expect(out.anomalies.map((a) => a.code)).toContain(code);
      expect(out.recommendations[0]!.code).toBe("REVIEW_DATA_QUALITY");
    }
  });

  it("excludes overlapping windows from the time series and keeps hard advisory guarantees", () => {
    const out = analyzePaidCampaignWindows("meta", "1", [...history(), win("09-01", "10-07", { spendEur: 9999 })]);
    expect(out.windows).toHaveLength(4);
    expect(out.dataQuality.overlappingWindowsExcluded).toBe(1);
    expect(out).toMatchObject({ marketplaceAttributionVerified: false, marketplaceRoas: null, organicMetricsIncluded: false, eligibleForAutomaticAction: false, budgetChangeEur: null, spendAuthorized: false });
  });
});

describe("ADS-007 history reader over real SQLite analytics tables", () => {
  const campaignId = "120210000000000001";
  function store(db: ReturnType<typeof createTestDb>, w: PaidWindowMetrics, opts: { campaign?: string; currency?: string; account?: string | null } = {}) {
    const campaign = opts.campaign ?? campaignId;
    const metric = (metricKey: string, numericValue: number | null, unit: string) => ({
      scopeType: "external_ad_campaign", scopeId: `paid_meta:${campaign}`, metricNamespace: "paid_meta", metricKey, numericValue, textValue: null,
      valueState: numericValue === null ? "unknown" : "known", unit,
      metadata: { paidAdsSource: true, provider: "meta", ...(opts.account === null ? {} : { accountId: opts.account ?? "3095361257478763" }), campaignId: campaign, currency: opts.currency ?? "EUR", windowSemantics: "fixed_range", window: w.period },
    });
    return createSqliteAnalyticsSnapshotRepository(db).writeCompletedRun(
      { id: `run-${campaign}-${opts.account ?? "a"}-${w.period.end}`, runType: "paid_meta_campaign_metrics", sourceType: "external_platform", sourceReference: w.sourceReference, idempotencyKey: `paid:meta:${opts.account ?? "a"}:${campaign}:${w.period.start}:${w.period.end}`, observedAt: w.period.end, startedAt: "2026-10-09T12:00:00.000Z" },
      "2026-10-09T12:00:00.000Z", "2026-10-09T12:00:00.000Z",
      [metric("paid_spend_eur", w.spendEur, "eur"), metric("paid_impressions", w.impressions, "count"), metric("paid_clicks", w.clicks, "count"),
        metric("paid_provider_conversions", w.providerReportedConversions, "count"), metric("paid_provider_conversion_value_eur", w.providerReportedConversionValueEur, "eur")],
    );
  }

  it("analyses every trusted stored window, counts untrusted ones and ignores organic metrics and other campaigns", async () => {
    const db = createTestDb();
    for (const w of history({ spendEur: 210 })) store(db, w);
    store(db, win("08-30", "09-06"), { currency: "USD" }); // fails the canonical trust rules
    store(db, win("09-30", "10-07", { spendEur: 5000 }), { campaign: "999999999999" });
    createSqliteAnalyticsSnapshotRepository(db).writeCompletedRun(
      { id: "organic", runType: "social", sourceType: "external_platform", sourceReference: "instagram.graph", idempotencyKey: "organic", observedAt: day("10-07"), startedAt: day("10-07") },
      day("10-07"), day("10-07"),
      [{ scopeType: "social_media", scopeId: "ig-1", metricNamespace: "instagram", metricKey: "media_reach", numericValue: 99999, textValue: null, valueState: "known", unit: "count", metadata: null }],
    );
    const out = await readPaidCampaignIntelligence(db, "meta", campaignId);
    expect(out.status).toBe("ANALYSED");
    expect(out.windows.map((w) => w.period.end)).toEqual([day("10-07"), day("09-30"), day("09-23"), day("09-16")]);
    expect(out.windows[0]!.spendEur).toBe(210);
    expect(out.dataQuality.untrustedWindows).toBe(1);
    expect(out.anomalies.map((a) => a.code)).toContain("SPEND_SPIKE");
    expect(out.recommendations[0]!.code).toBe("REVIEW_DATA_QUALITY");
    expect(JSON.stringify(out)).not.toContain("99999");
  });

  it("quarantines a campaign history that mixes ad accounts instead of analysing it", async () => {
    const db = createTestDb();
    const [w1, w2, w3, w4] = history({ spendEur: 210 });
    for (const w of [w1!, w2!, w3!]) store(db, w);
    store(db, w4!, { account: "9999999999" }); // same provider campaign id, different ad account
    const out = await readPaidCampaignIntelligence(db, "meta", campaignId);
    expect(out).toMatchObject({ status: "ACCOUNT_CONFLICT", accountId: null, windows: [], trend: null, anomalies: [], spendAuthorized: false, eligibleForAutomaticAction: false });
    expect(out.accountConflict).toEqual([{ accountId: "3095361257478763", windows: 3 }, { accountId: "9999999999", windows: 1 }]);
    expect(out.recommendations.map((r) => r.code)).toEqual(["REVIEW_DATA_QUALITY"]);
    expect(JSON.stringify(out)).not.toContain("spendEur"); // no metric from either account is exposed
  });

  it("excludes windows without a verified stored account identity and reports the single account", async () => {
    const db = createTestDb();
    for (const w of history()) store(db, w);
    store(db, win("08-26", "09-02"), { account: null });
    store(db, win("08-19", "08-26"), { account: "12ab" });
    const out = await readPaidCampaignIntelligence(db, "meta", campaignId);
    expect(out).toMatchObject({ status: "ANALYSED", accountId: "3095361257478763", accountConflict: [] });
    expect(out.windows).toHaveLength(4);
    expect(out.dataQuality.untrustedWindows).toBe(2);
    expect(out.recommendations[0]!.code).toBe("REVIEW_DATA_QUALITY");
  });

  it("is NOT_COLLECTED for an unknown campaign and rejects malformed identifiers", async () => {
    const db = createTestDb();
    expect((await readPaidCampaignIntelligence(db, "google_ads", campaignId)).status).toBe("NOT_COLLECTED");
    await expect(readPaidCampaignIntelligence(db, "meta", "1 OR 1=1")).rejects.toThrow(/Invalid/);
  });
});
