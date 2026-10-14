import {
  assertPaidCampaignQuery, assertReportingTimeZone, paidReportingWindow,
  providerNumber, requirePaidCredentials, requirePaidEUR,
  type PaidCampaignQuery, type PaidProviderAccess,
} from "../../use-cases/ads/paidCampaignCollectorContract";
import { type MetaAdTrafficObservation } from "../../use-cases/ads/metaAdAbComparison";
import { PaidProviderReadError, isObject, paidGetJson } from "./paidTransport";

/** ADS-AB1: read two specified ads in ONE campaign, no write or collection side effects. */
export interface MetaAdPairQuery extends PaidCampaignQuery {
  readonly provider: "meta";
  readonly adAId: string;
  readonly adBId: string;
}
const numericId = (id: string) => /^[0-9]{5,25}$/.test(id);

export class MetaAdAbReadOnlyClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchAdPair(query: MetaAdPairQuery, access: PaidProviderAccess):
    Promise<readonly [MetaAdTrafficObservation, MetaAdTrafficObservation]> {
    if (query.provider !== "meta") throw new Error("ADS-AB1 provider is Meta only");
    assertPaidCampaignQuery(query);
    if (!numericId(query.adAId) || !numericId(query.adBId) || query.adAId === query.adBId) {
      throw new Error("ADS-AB1 requires two distinct numeric Meta ad IDs");
    }
    requirePaidCredentials(access);

    const accountUrl = new URL(`https://graph.facebook.com/v26.0/act_${query.accountId}`);
    accountUrl.searchParams.set("fields", "account_id,currency,timezone_name");
    const account = await paidGetJson(accountUrl, access, this.fetchImpl);
    if (!isObject(account) || String(account.account_id) !== query.accountId) {
      throw new PaidProviderReadError("malformed", "Meta ad account identity mismatch");
    }
    requirePaidEUR(account.currency);
    try { assertReportingTimeZone(account.timezone_name); }
    catch { throw new PaidProviderReadError("malformed", "Meta account timezone invalid"); }
    const reportingTimeZone = account.timezone_name as string;
    const window = paidReportingWindow(query, reportingTimeZone);
    if (Date.parse(window.end) > this.now().getTime()) {
      throw new PaidProviderReadError("rejected", "Meta account-local reporting window incomplete");
    }

    const url = new URL(`https://graph.facebook.com/v26.0/act_${query.accountId}/insights`);
    url.searchParams.set("level", "ad");
    url.searchParams.set("fields", "ad_id,campaign_id,spend,impressions,clicks,date_start,date_stop");
    url.searchParams.set("time_range", JSON.stringify({ since: query.startDate, until: query.endDate }));
    url.searchParams.set("filtering", JSON.stringify([
      { field: "campaign.id", operator: "EQUAL", value: query.campaignId },
      { field: "ad.id", operator: "IN", value: [query.adAId, query.adBId] },
    ]));
    url.searchParams.set("limit", "3");

    const response = await paidGetJson(url, access, this.fetchImpl);
    if (!isObject(response) || !Array.isArray(response.data)
      || response.data.length !== 2
      || isObject(response.paging) && Boolean(response.paging.next)) {
      throw new PaidProviderReadError("malformed", "Missing, unexpected or paginated Meta ad report");
    }
    const expected = new Set([query.adAId, query.adBId]);
    const observations = new Map<string, MetaAdTrafficObservation>();
    for (const record of response.data as unknown[]) {
      if (!isObject(record) || typeof record.ad_id !== "string" || !expected.has(record.ad_id)
        || String(record.campaign_id) !== query.campaignId
        || record.date_start !== query.startDate || record.date_stop !== query.endDate
        || observations.has(record.ad_id)) {
        throw new PaidProviderReadError("malformed", "Meta ad identity, period or duplicate mismatch");
      }
      observations.set(record.ad_id, {
        adId: record.ad_id, accountId: query.accountId, campaignId: query.campaignId,
        currency: "EUR", reportingTimeZone, window, sourceReference: "meta.ads.graph_v26_ad_insights",
        spendEur: providerNumber(record.spend, "money"),
        impressions: providerNumber(record.impressions, "count"),
        clicks: providerNumber(record.clicks, "count"),
      });
    }
    const a = observations.get(query.adAId), b = observations.get(query.adBId);
    if (!a || !b) throw new PaidProviderReadError("malformed", "Meta ad pair incomplete");
    return [a, b];
  }
}
