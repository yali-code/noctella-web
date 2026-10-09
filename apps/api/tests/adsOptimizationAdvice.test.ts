import { describe, expect, it } from "vitest";
import { assessAdsOptimization } from "../src/use-cases/ads/adsOptimizationAdvice";
import { evaluateAdsPerformanceEvidence, type PaidMetricFacts } from "../src/use-cases/ads/adsPerformanceEvidence";
const baseline: PaidMetricFacts = {
 provider:"google_ads", periodStart:"2026-10-01T00:00:00Z", periodEnd:"2026-10-08T00:00:00Z",
 currency:"EUR", spendEur:12, impressions:1100, clicks:24,
 providerReportedConversions:null, providerReportedConversionValueEur:null, marketplaceConfirmedOrders:null,
};
describe("ADS-006B advisory-only paid optimization", () => {
  it("never authorizes budget or pause changes even with vendor returns", () => {
    const evidence=evaluateAdsPerformanceEvidence({...baseline,providerReportedConversions:2,providerReportedConversionValueEur:45});
    const advice=assessAdsOptimization(evidence);
    expect(advice.recommendation).toBe("REVIEW_PROVIDER_REPORTED_RETURN");
    expect(advice.eligibleForAutomaticAction).toBe(false);
    expect(advice.budgetChangeEur).toBeNull();
    expect(advice.campaignPauseExecuted).toBe(false);
    expect(advice.spendAuthorized).toBe(false);
  });
  it("distinguishes incomplete data and traffic-only observations", () => {
    expect(assessAdsOptimization(evaluateAdsPerformanceEvidence({...baseline,spendEur:null})).recommendation).toBe("COLLECT_MORE_EVIDENCE");
    expect(assessAdsOptimization(evaluateAdsPerformanceEvidence(baseline)).recommendation).toBe("REVIEW_SPEND_AND_TRAFFIC");
  });
  it("routes invalid evidence to data-quality review", () => {
    const evidence=evaluateAdsPerformanceEvidence({...baseline,periodEnd:"invalid"});
    expect(assessAdsOptimization(evidence).recommendation).toBe("REVIEW_DATA_QUALITY");
  });
});
