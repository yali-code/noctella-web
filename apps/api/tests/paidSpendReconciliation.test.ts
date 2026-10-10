import {describe,it,expect} from "vitest";
import {buildPaidCampaignReadout} from "../src/use-cases/ads/adsPaidCampaignRead";
import {reconcilePaidSpend,type PaidSpendReconciliationInput} from "../src/use-cases/ads/paidSpendReconciliation";
const first="2026-10-01T00:00:00.000Z",last="2026-10-03T00:00:00.000Z";
const campaignId="123456780";
/** Synthetic analytics snapshot rows in the reserved paid-collector contract (run provenance included). */
function storedRows(o:{spend?:number|null;clicks?:number;campaign?:string;window?:{start:string;end:string}}={}){
  const campaign=o.campaign??campaignId,window=o.window??{start:first,end:last};
  const metric=(metricKey:string,value:number|null,unit:string)=>({runId:"run-1",runStatus:"completed",
    runSourceType:"external_platform",runSourceReference:"meta.ads.graph_v26_insights",
    scopeType:"external_ad_campaign",scopeId:`paid_meta:${campaign}`,metricNamespace:"paid_meta",metricKey,
    numericValue:value,valueState:value===null?"unknown":"known",unit,sourceType:"external_platform",
    sourceReference:"meta.ads.graph_v26_insights",observedAt:window.end,collectedAt:"2026-10-09T12:00:00.000Z",
    metadataJson:JSON.stringify({paidAdsSource:true,provider:"meta",accountId:"123456789",campaignId:campaign,
      currency:"EUR",windowSemantics:"fixed_range",window})});
  return [metric("paid_spend_eur",o.spend===undefined?15.25:o.spend,"eur"),metric("paid_impressions",500,"count"),
    metric("paid_clicks",o.clicks??20,"count"),metric("paid_provider_conversions",null,"count"),
    metric("paid_provider_conversion_value_eur",null,"eur")];
}
const stored=(o:Parameters<typeof storedRows>[0]={})=>buildPaidCampaignReadout("meta",o.campaign??campaignId,storedRows(o));
const input:PaidSpendReconciliationInput={provider:"meta",accountId:"123456789",campaignId,
 reportWindow:{start:first,end:last},report:stored(),
 billing:{provider:"meta",accountId:"123456789",campaignId,currency:"EUR",
  period:{start:first,end:last},comparableAdSpendEur:15.25,adSpendOnly:true,
  fromVerifiedProviderBilling:true,settlementFinal:true,sourceReference:"verified-provider-statement-id"}};
describe("ADS-006H paid spend reconciliation is advisory-only",()=>{
 it("reconciles independently verified, settled EUR advertising spend without allowing budget changes",()=>{
  expect(input.report?.status).toBe("REPORT_AVAILABLE");
  const out=reconcilePaidSpend(input);
  expect(out.status).toBe("RECONCILED_FOR_REVIEW");
  expect(out.differenceEur).toBe(0);
  expect(out.spendAuthorized).toBe(false);
  expect(out.eligibleForAutomaticBudgetChange).toBe(false);
  expect(out.independentlyVerifiedMarketplaceRevenueEur).toBeNull();
 });
 it("never treats missing analytics or billing data as zero spend",()=>{
  expect(reconcilePaidSpend({...input,report:null}).status).toBe("MISSING_REPORT");
  expect(reconcilePaidSpend({...input,report:buildPaidCampaignReadout("meta",campaignId,[])}).status).toBe("MISSING_REPORT");
  const unknownSpend=reconcilePaidSpend({...input,report:stored({spend:null})});
  expect(unknownSpend.status).toBe("MISSING_REPORT");
  expect(unknownSpend.reportSpendEur).toBeNull();
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
 it("binds the report to its stored provenance: another campaign or window cannot be reconciled",()=>{
  // Same spend figure, but the stored evidence belongs to a different campaign / period.
  expect(reconcilePaidSpend({...input,report:stored({campaign:"999999999"})}).status).toBe("SCOPE_MISMATCH");
  expect(reconcilePaidSpend({...input,report:stored({window:{start:"2026-09-30T21:00:00.000Z",end:"2026-10-02T21:00:00.000Z"}})}).status).toBe("SCOPE_MISMATCH");
  expect(reconcilePaidSpend({...input,provider:"google_ads",billing:{...input.billing!,provider:"google_ads"}}).status).toBe("SCOPE_MISMATCH");
 });
 it("rejects non-comparable fees and material spend mismatch",()=>{
  expect(reconcilePaidSpend({...input,billing:{...input.billing!,adSpendOnly:false}}).status).toBe("NON_COMPARABLE_BILLING");
  const out=reconcilePaidSpend({...input,billing:{...input.billing!,comparableAdSpendEur:18.3}});
  expect(out.status).toBe("SPEND_MISMATCH");
  expect(out.differenceEur).toBeCloseTo(3.05);
 });
 it("fails closed when stored evidence is untrusted or internally contradictory",()=>{
  const untrusted=buildPaidCampaignReadout("meta",campaignId,storedRows().map(r=>({...r,runStatus:"failed"})));
  expect(untrusted.status).toBe("UNTRUSTED_EVIDENCE");
  expect(reconcilePaidSpend({...input,report:untrusted}).status).toBe("INVALID_REPORT");
  expect(reconcilePaidSpend({...input,report:stored({clicks:900})}).status).toBe("INVALID_REPORT");
 });

});
