import {describe,it,expect} from "vitest";
import {evaluateAdsPerformanceEvidence,type PaidMetricFacts} from "../src/use-cases/ads/adsPerformanceEvidence";
import {reconcilePaidSpend,type PaidSpendReconciliationInput} from "../src/use-cases/ads/paidSpendReconciliation";
const first="2026-10-01T00:00:00.000Z",last="2026-10-03T00:00:00.000Z";
const facts:PaidMetricFacts={provider:"meta",periodStart:first,periodEnd:last,currency:"EUR",spendEur:15.25,
 impressions:500,clicks:20,providerReportedConversions:null,providerReportedConversionValueEur:null,marketplaceConfirmedOrders:null};
const input:PaidSpendReconciliationInput={provider:"meta",accountId:"123456789",campaignId:"123456780",
 reportWindow:{start:first,end:last},report:evaluateAdsPerformanceEvidence(facts),
 billing:{provider:"meta",accountId:"123456789",campaignId:"123456780",currency:"EUR",
  period:{start:first,end:last},comparableAdSpendEur:15.25,adSpendOnly:true,
  fromVerifiedProviderBilling:true,settlementFinal:true,sourceReference:"verified-provider-statement-id"}};
describe("ADS-006H paid spend reconciliation is advisory-only",()=>{
 it("reconciles independently verified, settled EUR advertising spend without allowing budget changes",()=>{
  const out=reconcilePaidSpend(input);
  expect(out.status).toBe("RECONCILED_FOR_REVIEW");
  expect(out.differenceEur).toBe(0);
  expect(out.spendAuthorized).toBe(false);
  expect(out.eligibleForAutomaticBudgetChange).toBe(false);
  expect(out.independentlyVerifiedMarketplaceRevenueEur).toBeNull();
 });
 it("never treats missing analytics or billing data as zero spend",()=>{
  expect(reconcilePaidSpend({...input,report:null}).status).toBe("MISSING_REPORT");
  const noBilling=reconcilePaidSpend({...input,billing:null});
  expect(noBilling.status).toBe("MISSING_BILLING");
  expect(noBilling.billingSpendEur).toBeNull();
 });
 it("requires verified EUR, exact campaign identity and final settlement",()=>{
  expect(reconcilePaidSpend({...input,billing:{...input.billing!,currency:"USD"}}).status).toBe("CURRENCY_MISMATCH");
  expect(reconcilePaidSpend({...input,billing:{...input.billing!,campaignId:"333334"}}).status).toBe("SCOPE_MISMATCH");
  expect(reconcilePaidSpend({...input,billing:{...input.billing!,fromVerifiedProviderBilling:false}}).status).toBe("UNVERIFIED_BILLING");
  expect(reconcilePaidSpend({...input,billing:{...input.billing!,settlementFinal:false}}).status).toBe("UNSETTLED");
 });
 it("rejects non-comparable fees and material spend mismatch",()=>{
  expect(reconcilePaidSpend({...input,billing:{...input.billing!,adSpendOnly:false}}).status).toBe("NON_COMPARABLE_BILLING");
  const out=reconcilePaidSpend({...input,billing:{...input.billing!,comparableAdSpendEur:18.3}});
  expect(out.status).toBe("SPEND_MISMATCH");
  expect(out.differenceEur).toBeCloseTo(3.05);
 });
});
