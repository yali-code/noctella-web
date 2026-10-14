// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MetaAdAbReadOnlyClient } from "../src/integrations/ads/metaAdAbReadOnlyClient";
import { previewMetaAdAbFromEnv } from "../src/scripts/previewMetaAdAb";

const accountId = "3095361257478763";
const campaignId = "120251730775610455";
const adAId = "120251730775610456";
const adBId = "120251730775610457";
const startDate = "2026-10-10";
const now = new Date("2026-10-14T12:00:00Z");
const query = { provider: "meta" as const, accountId, campaignId, adAId, adBId, startDate, endDate: startDate };
const account = { account_id: accountId, currency: "EUR", timezone_name: "Europe/Sofia" };
const rows = [
  { ad_id: adAId, campaign_id: campaignId, spend: "6.00", impressions: "2000", clicks: "120", date_start: startDate, date_stop: startDate },
  { ad_id: adBId, campaign_id: campaignId, spend: "8.00", impressions: "2000", clicks: "40", date_start: startDate, date_stop: startDate },
];
type Seen = { url: URL; method: string; authorization: string | undefined };
const mockProvider = (data: unknown = { data: rows }, accountData: unknown = account) => {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", authorization: headers.get("Authorization") ?? undefined });
    return new Response(JSON.stringify(url.pathname.endsWith("/insights") ? data : accountData), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
};
const env = {
  RENDER_SERVICE_NAME: "noctella-staging-api",
  DATABASE_DRIVER: "sqlite",
  DATABASE_URL: "/var/data/noctella.sqlite",
  NOCTELLA_PAID_ADS_PREVIEW_ACK: "I_AUTHORIZE_PAID_READ_ONLY",
  NOCTELLA_AB_PREVIEW_ACK: "I_AUTHORIZE_META_AD_AB_READ_ONLY",
  NOCTELLA_META_AD_ACCOUNT_ID: accountId,
  NOCTELLA_META_AD_ACCESS_TOKEN: "test-only-token-do-not-use",
  NOCTELLA_AB_CAMPAIGN_ID: campaignId,
  NOCTELLA_AB_AD_A_ID: adAId,
  NOCTELLA_AB_AD_B_ID: adBId,
  NOCTELLA_AB_START_DATE: startDate,
  NOCTELLA_AB_END_DATE: startDate,
};

describe("ADS-AB1 strict read-only Meta ad pair client", () => {
  it("requests exactly two ad-level reports with fixed campaign/ad IDs and no provider mutations", async () => {
    const { fetchImpl, seen } = mockProvider();
    const [a, b] = await new MetaAdAbReadOnlyClient(fetchImpl, () => now)
      .fetchAdPair(query, { accessToken: "test-only-access-token" });
    expect([a.adId, b.adId]).toEqual([adAId, adBId]);
    expect(a).toMatchObject({
      accountId, campaignId, spendEur: 6, impressions: 2000, clicks: 120,
      reportingTimeZone: "Europe/Sofia", currency: "EUR",
      window: { start: "2026-10-09T21:00:00.000Z", end: "2026-10-10T21:00:00.000Z" },
    });
    expect(seen).toHaveLength(2);
    expect(seen.every(s => s.method === "GET" && s.url.host === "graph.facebook.com")).toBe(true);
    expect(seen[1]!.url.searchParams.get("level")).toBe("ad");
    const filters = JSON.parse(seen[1]!.url.searchParams.get("filtering")!);
    expect(filters).toEqual([
      { field: "campaign.id", operator: "EQUAL", value: campaignId },
      { field: "ad.id", operator: "IN", value: [adAId, adBId] },
    ]);
    expect(seen[1]!.url.searchParams.get("time_range")).toBe(JSON.stringify({ since: startDate, until: startDate }));
    expect(seen.every(s => s.authorization === "Bearer test-only-access-token")).toBe(true);
  });

  it("denies absent, duplicate, out-of-campaign, wrong-date or paginated Meta rows", async () => {
    const cases = [
      { data: [] },
      { data: [rows[0]] },
      { data: [rows[0], rows[0]] },
      { data: [rows[0], { ...rows[1], campaign_id: "99999999999" }] },
      { data: [rows[0], { ...rows[1], date_stop: "2026-10-11" }] },
      { data: rows, paging: { next: "https://graph.facebook.com/next" } },
      { data: [rows[0], { ...rows[1], ad_id: "1234512345" }] },
    ];
    for (const response of cases) {
      const { fetchImpl } = mockProvider(response);
      await expect(new MetaAdAbReadOnlyClient(fetchImpl, () => now)
        .fetchAdPair(query, { accessToken: "test-only-access-token" })).rejects.toThrow();
    }
  });

  it("rejects wrong EUR account, account identity, incomplete day and malformed IDs", async () => {
    for (const changed of [
      { currency: "USD" },
      { account_id: "99999999999" },
      { timezone_name: "Unknown/Zone" },
    ]) {
      const { fetchImpl } = mockProvider({ data: rows }, { ...account, ...changed });
      await expect(new MetaAdAbReadOnlyClient(fetchImpl, () => now)
        .fetchAdPair(query, { accessToken: "test-only-access-token" })).rejects.toThrow();
    }
    const { fetchImpl, seen } = mockProvider();
    await expect(new MetaAdAbReadOnlyClient(fetchImpl, () => new Date("2026-10-10T08:00:00Z"))
      .fetchAdPair(query, { accessToken: "test-only-access-token" })).rejects.toThrow(/incomplete/);
    expect(seen).toHaveLength(1); // fail before fetching insights
    for (const input of [{ ...query, adBId: adAId }, { ...query, adAId: "abc" }]) {
      const m = mockProvider();
      await expect(new MetaAdAbReadOnlyClient(m.fetchImpl, () => now)
        .fetchAdPair(input, { accessToken: "test-only-access-token" })).rejects.toThrow();
      expect(m.seen).toHaveLength(0);
    }
  });

  it("manual CLI fails closed before provider contact without staging identity and BOTH acknowledgements", async () => {
    for (const changed of [
      { RENDER_SERVICE_NAME: "noctella-production-api" },
      { DATABASE_URL: "/tmp/other.sqlite" },
      { NOCTELLA_AB_PREVIEW_ACK: undefined },
      { NOCTELLA_PAID_ADS_PREVIEW_ACK: undefined },
    ]) {
      const m = mockProvider();
      await expect(previewMetaAdAbFromEnv({ ...env, ...changed }, m.fetchImpl, now)).rejects.toThrow();
      expect(m.seen).toHaveLength(0);
    }
  });

  it("manual staging preview contains only provenance, traffic, diagnostic and hard false authority flags", async () => {
    const m = mockProvider();
    const result = await previewMetaAdAbFromEnv(env, m.fetchImpl, now);
    expect(result).toMatchObject({
      operation: "PREVIEW_ONLY", verdict: "DIRECTIONAL_TRAFFIC_LEAD",
      directionalLeaderAdId: adAId, comparisonIsRandomizedExperimentVerified: false,
      causalAbWinnerVerified: false, marketplaceAttributionVerified: false,
      marketplaceRoas: null, databaseWritePerformed: false,
      campaignModified: false, spendAuthorized: false,
    });
    expect(m.seen).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("test-only-token-do-not-use");
  });
});
