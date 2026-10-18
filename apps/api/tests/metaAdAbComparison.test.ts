// @vitest-environment node
import { describe, expect, it } from "vitest";
import { compareMetaAdTraffic, type MetaAdTrafficObservation } from "../src/use-cases/ads/metaAdAbComparison";

const aId = "120251730775610456";
const bId = "120251730775610457";
const observation = (adId: string, changes: Partial<MetaAdTrafficObservation> = {}): MetaAdTrafficObservation => ({
  adId, accountId: "3095361257478763", campaignId: "120251730775610455",
  reportingTimeZone: "Europe/Sofia", currency: "EUR",
  sourceReference: "meta.ads.graph_v26_ad_insights",
  window: { start: "2026-10-09T21:00:00.000Z", end: "2026-10-10T21:00:00.000Z" },
  spendEur: 6, impressions: 2000, clicks: 120, ...changes,
});

describe("ADS-AB1 ad-level comparison (all clicks, advisory only)", () => {
  it("derives CTR/CPC/CPM and a directional traffic leader, not a causal A/B or marketplace winner", () => {
    const result = compareMetaAdTraffic(
      observation(aId),
      observation(bId, { spendEur: 8, impressions: 2000, clicks: 40 }),
    );
    expect(result).toMatchObject({
      verdict: "DIRECTIONAL_TRAFFIC_LEAD", directionalLeaderAdId: aId,
      clickDefinition: "META_ALL_CLICKS",
      comparisonIsRandomizedExperimentVerified: false, causalAbWinnerVerified: false,
      marketplaceAttributionVerified: false, marketplaceRoas: null,
      campaignModified: false, spendAuthorized: false,
    });
    expect(result.metrics[0]).toMatchObject({ ctr: 0.06, cpcEur: 0.05, cpmEur: 3 });
    expect(result.metrics[1]).toMatchObject({ ctr: 0.02, cpcEur: 0.2, cpmEur: 4 });
    expect(result.absoluteCtrZScore).toBeGreaterThan(1.96);
  });

  it("refuses premature winners for small impressions or few clicks", () => {
    for (const changed of [{ impressions: 999, clicks: 40 }, { impressions: 2000, clicks: 29 }]) {
      const result = compareMetaAdTraffic(observation(aId, changed), observation(bId, { spendEur: 8, impressions: 2000, clicks: 40 }));
      expect(result).toMatchObject({ verdict: "INSUFFICIENT_EVIDENCE", directionalLeaderAdId: null });
    }
  });

  it("does not declare a leader when CTR differences are insignificant", () => {
    const result = compareMetaAdTraffic(observation(aId, { clicks: 80 }), observation(bId, { clicks: 78 }));
    expect(result).toMatchObject({ verdict: "NO_CLEAR_TRAFFIC_DIFFERENCE", directionalLeaderAdId: null });
  });

  it("rejects a conflicting CPC direction despite a significant CTR difference", () => {
    const result = compareMetaAdTraffic(observation(aId, { spendEur: 40 }), observation(bId, { clicks: 40, spendEur: 4 }));
    expect(result).toMatchObject({ verdict: "NO_CLEAR_TRAFFIC_DIFFERENCE", directionalLeaderAdId: null });
  });

  it("keeps missing spend, impressions and clicks unknown instead of zero", () => {
    for (const missing of [{ spendEur: null }, { impressions: null }, { clicks: null }]) {
      const result = compareMetaAdTraffic(observation(aId, missing), observation(bId));
      expect(result).toMatchObject({ verdict: "INSUFFICIENT_EVIDENCE", directionalLeaderAdId: null });
      expect(result.reasons).toContain("MISSING_METRICS_NOT_ZERO");
    }
  });

  it("flags contradicted or non-finite metrics for manual review", () => {
    for (const bad of [{ impressions: 10, clicks: 11 }, { spendEur: -1 }, { clicks: 1.5 }, { spendEur: Number.NaN }]) {
      const result = compareMetaAdTraffic(observation(aId, bad), observation(bId));
      expect(result).toMatchObject({ verdict: "DATA_QUALITY_REVIEW", directionalLeaderAdId: null });
    }
  });

  it("rejects different ad/campaign/account/timezone/window and duplicate ad identities", () => {
    const a = observation(aId);
    const variations: MetaAdTrafficObservation[] = [
      observation(aId),
      observation(bId, { accountId: "999999999999" }),
      observation(bId, { campaignId: "999999999999" }),
      observation(bId, { reportingTimeZone: "UTC" }),
      observation(bId, { window: { start: a.window.start, end: "2026-10-11T21:00:00.000Z" } }),
    ];
    for (const b of variations) expect(() => compareMetaAdTraffic(a, b)).toThrow(/provenance|window/);
  });
});


describe("ADS-AB1 invalid metric hardening", () => {
  it.each([
    { impressions: -1 }, { clicks: -1 }, { impressions: 10, clicks: 11 },
    { impressions: Number.NaN }, { impressions: Infinity },
    { clicks: Number.NaN }, { clicks: Infinity },
    { impressions: 2000.5 }, { clicks: 1.5 },
    { spendEur: -1 }, { spendEur: Number.NaN }, { spendEur: Infinity },
    { spendEur: 0.001 },
  ])("suppresses invalid ratios in either position: %j", bad => {
    for (const invalidIndex of [0, 1]) {
      const result = compareMetaAdTraffic(
        observation(aId, invalidIndex === 0 ? bad : {}),
        observation(bId, invalidIndex === 1 ? bad : {}),
      );
      expect(result).toMatchObject({
        verdict: "DATA_QUALITY_REVIEW", directionalLeaderAdId: null,
        absoluteCtrZScore: null, causalAbWinnerVerified: false,
        comparisonIsRandomizedExperimentVerified: false,
        marketplaceAttributionVerified: false, marketplaceRoas: null,
      });
      expect(result.reasons).toContain("INVALID_META_NUMERIC_EVIDENCE");
      expect(result.metrics[invalidIndex]).toMatchObject({ ...bad, ctr: null, cpcEur: null, cpmEur: null });
      expect(result.metrics[1 - invalidIndex]).toMatchObject({ ctr: 0.06, cpcEur: 0.05, cpmEur: 3 });
      for (const metric of result.metrics) {
        for (const ratio of [metric.ctr, metric.cpcEur, metric.cpmEur]) {
          expect(ratio === null || Number.isFinite(ratio)).toBe(true);
        }
      }
    }
  });

  it.each([
    { changes: { impressions: 0, clicks: 0 }, ctr: null, cpcEur: null, cpmEur: null },
    { changes: { clicks: 0 }, ctr: 0, cpcEur: null, cpmEur: 3 },
    { changes: { spendEur: 0 }, ctr: 0.06, cpcEur: 0, cpmEur: 0 },
    { changes: { impressions: null }, ctr: null, cpcEur: 0.05, cpmEur: null },
    { changes: { clicks: null }, ctr: null, cpcEur: null, cpmEur: 3 },
    { changes: { spendEur: null }, ctr: 0.06, cpcEur: null, cpmEur: null },
  ])("preserves zero and missing evidence: %j", ({ changes, ...ratios }) => {
    const result = compareMetaAdTraffic(observation(aId, changes), observation(bId));
    expect(result).toMatchObject({
      verdict: "INSUFFICIENT_EVIDENCE", directionalLeaderAdId: null,
      causalAbWinnerVerified: false, marketplaceAttributionVerified: false, marketplaceRoas: null,
    });
    expect(result.metrics[0]).toMatchObject({ ...changes, ...ratios });
    expect(result.reasons).toContain(Object.values(changes).includes(null)
      ? "MISSING_METRICS_NOT_ZERO" : "INSUFFICIENT_PER_AD_TRAFFIC_SAMPLE");
  });
});
