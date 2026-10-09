import { describe, expect, it } from "vitest";
import { buildPaidCampaignReadout, type PaidSnapshotRow } from "../src/use-cases/ads/adsPaidCampaignRead";
const provider = "meta" as const, campaignId = "123456789";
const metadataJson = JSON.stringify({
  paidAdsSource: true, provider, campaignId, currency: "EUR", windowSemantics: "fixed_range",
  window: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" },
});
const row = (metricKey: string, numericValue: number|null, unit: string): PaidSnapshotRow => ({
  runId:"verified-run-id",runStatus:"completed",scopeType:"external_ad_campaign",
  scopeId:"paid_meta:123456789",metricNamespace:"paid_meta",
  metricKey,numericValue,valueState:numericValue===null?"unknown":"known",unit,
  sourceType:"external_platform",sourceReference:"meta.ads.insights",
  observedAt:"2026-10-08T00:00:00.000Z",collectedAt:"2026-10-09T00:00:00.000Z",metadataJson,
});
const valid = [row("paid_spend_eur",10,"eur"),row("paid_impressions",1000,"count"),
  row("paid_clicks",20,"count"), row("paid_provider_conversions",null,"count"),
  row("paid_provider_conversion_value_eur",null,"eur")];
describe("ADS-006C paid campaign report over existing Analytics Agent snapshots", () => {
  it("returns unknown rather than zero when there is no verified paid collector", () => {
    const r=buildPaidCampaignReadout(provider,campaignId,[]);
    expect(r.status).toBe("NOT_COLLECTED");
    expect(r.evidence).toBeNull();
    expect(r.spendAuthorized).toBe(false);
  });
  it("separates spend and traffic from confirmed marketplace revenue", () => {
    const r=buildPaidCampaignReadout(provider,campaignId,valid);
    expect(r.status).toBe("REPORT_AVAILABLE");
    expect(r.evidence?.spendEur).toBe(10);
    expect(r.evidence?.reportedRoas).toBeNull();
    expect(r.evidence?.attributedMarketplaceRevenueEur).toBeNull();
    expect(r.advice?.budgetChangeEur).toBeNull();
  });
  it("rejects organic or unsigned snapshots rather than mixing into paid reports", () => {
    const wrong = {...valid[0]!,scopeType:"external_media",metricNamespace:"instagram"};
    expect(buildPaidCampaignReadout(provider,campaignId,[wrong]).status).toBe("UNTRUSTED_EVIDENCE");
    expect(buildPaidCampaignReadout(provider,campaignId,[{...valid[0]!,metadataJson:null}]).status).toBe("UNTRUSTED_EVIDENCE");
    expect(buildPaidCampaignReadout(provider,campaignId,[{...valid[0]!,runStatus:"failed"}]).status).toBe("UNTRUSTED_EVIDENCE");
  });
  it("does not merge different observation windows or duplicated metric keys", () => {
    expect(buildPaidCampaignReadout(provider,campaignId,[valid[0]!,valid[0]!]).status).toBe("UNTRUSTED_EVIDENCE");
    const mismatched = {...valid[1]!,sourceReference:"meta.ads.other"};
    expect(buildPaidCampaignReadout(provider,campaignId,[valid[0]!,mismatched]).status).toBe("UNTRUSTED_EVIDENCE");
  });
  it("preserves reported ROAS with explicit provider value, never confirmed purchase claims", () => {
    const rows=[...valid.slice(0,3),row("paid_provider_conversions",2,"count"),row("paid_provider_conversion_value_eur",30,"eur")];
    const r=buildPaidCampaignReadout(provider,campaignId,rows);
    expect(r.evidence?.reportedRoas).toBe(3);
    expect(r.marketplaceAttributionVerified).toBe(false);
  });
});
