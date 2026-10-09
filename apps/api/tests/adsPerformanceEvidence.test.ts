import { describe, expect, it } from "vitest";
import { evaluateAdsPerformanceEvidence, type PaidMetricFacts } from "../src/use-cases/ads/adsPerformanceEvidence";
const metrics: PaidMetricFacts = { provider:"meta",periodStart:"2026-10-01T00:00:00Z",periodEnd:"2026-10-08T00:00:00Z",currency:"EUR",spendEur:10,impressions:1000,clicks:20,providerReportedConversions:null,providerReportedConversionValueEur:null,marketplaceConfirmedOrders:null };
describe("ADS-006A strict paid performance attribution evidence", () => {
  it("keeps spend and outbound traffic without inventing paid sales", () => {
    const r=evaluateAdsPerformanceEvidence(metrics);
    expect(r.evidenceLevel).toBe("SPEND_AND_TRAFFIC_ONLY");
    expect(r.reportedRoas).toBeNull();
    expect(r.attributedMarketplaceRevenueEur).toBeNull();
    expect(r.cannotInferMarketplacePurchasesFromClicks).toBe(true);
  });
  it("reports vendor ROAS only as explicitly provider-reported, not confirmed orders", () => {
    const r=evaluateAdsPerformanceEvidence({...metrics,providerReportedConversions:2,providerReportedConversionValueEur:30,marketplaceConfirmedOrders:1});
    expect(r.reportedRoas).toBe(3);
    expect(r.evidenceLevel).toBe("PROVIDER_REPORTED_CONVERSIONS");
    expect(r.attributedMarketplaceRevenueEur).toBeNull();
    expect(r.warnings).toContain("ORDERS_NOT_AD_ATTRIBUTED");
  });
  it("keeps unknown costs unknown, not zero", () => {
    const r=evaluateAdsPerformanceEvidence({...metrics,spendEur:null,providerReportedConversions:1,providerReportedConversionValueEur:10});
    expect(r.reportedRoas).toBeNull();
    expect(r.evidenceLevel).toBe("INCOMPLETE");
  });
  it("refuses invalid periods, negative metrics and unsupported zero-spend ROAS", () => {
    expect(evaluateAdsPerformanceEvidence({...metrics,periodEnd:metrics.periodStart}).warnings).toContain("INVALID_PERIOD");
    expect(evaluateAdsPerformanceEvidence({...metrics,spendEur:-2}).reportedRoas).toBeNull();
    expect(evaluateAdsPerformanceEvidence({...metrics,spendEur:0,providerReportedConversions:1,providerReportedConversionValueEur:20}).reportedRoas).toBeNull();
  });
});
