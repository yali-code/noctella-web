import type { AdsPerformanceEvidence, AdsMetricsProvider } from "./adsPerformanceEvidence";

/** Strict, independent provider billing evidence. Never inferred from clicks or order counts. */
export interface VerifiedPaidBillingEvidence {
  readonly provider: AdsMetricsProvider;
  readonly accountId: string;
  readonly campaignId: string;
  readonly currency: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly comparableAdSpendEur: number | null;
  /** Explicitly exclude taxes, adjustments and other billing-only fees. */
  readonly adSpendOnly: boolean;
  readonly fromVerifiedProviderBilling: boolean;
  readonly settlementFinal: boolean;
  readonly sourceReference: string;
}
export type PaidSpendReconciliationStatus =
  | "MISSING_REPORT" | "MISSING_BILLING" | "UNVERIFIED_BILLING"
  | "CURRENCY_MISMATCH" | "SCOPE_MISMATCH" | "UNSETTLED"
  | "NON_COMPARABLE_BILLING" | "INVALID_AMOUNT" | "INVALID_REPORT" | "SPEND_MISMATCH"
  | "RECONCILED_FOR_REVIEW";
export interface PaidSpendReconciliation {
  readonly status: PaidSpendReconciliationStatus;
  readonly provider: AdsMetricsProvider;
  readonly reportSpendEur: number | null;
  readonly billingSpendEur: number | null;
  readonly differenceEur: number | null;
  readonly explanation: string;
  readonly independentlyVerifiedMarketplaceRevenueEur: null;
  readonly eligibleForAutomaticBudgetChange: false;
  readonly spendAuthorized: false;
}
export interface PaidSpendReconciliationInput {
  readonly provider: AdsMetricsProvider;
  readonly accountId: string;
  readonly campaignId: string;
  readonly reportWindow: {readonly start:string;readonly end:string};
  readonly report: AdsPerformanceEvidence|null;
  readonly billing: VerifiedPaidBillingEvidence|null;
}
function positiveCents(v:number|null):v is number{
  return v!==null&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))
    && Math.abs(v*100-Math.round(v*100))<0.000001;
}
function validInterval(v:{start:string;end:string}){
  return Number.isFinite(Date.parse(v.start))&&Number.isFinite(Date.parse(v.end))
    && Date.parse(v.start)<Date.parse(v.end);
}
export function reconcilePaidSpend(input:PaidSpendReconciliationInput):PaidSpendReconciliation{
  const reportSpend=input.report?.spendEur ?? null,billingSpend=input.billing?.comparableAdSpendEur ?? null;
  const out=(status:PaidSpendReconciliationStatus,explanation:string,differenceEur:number|null=null):PaidSpendReconciliation=>({
    status,provider:input.provider,reportSpendEur:positiveCents(reportSpend)?reportSpend:null,
    billingSpendEur:positiveCents(billingSpend)?billingSpend:null,
    differenceEur,explanation,independentlyVerifiedMarketplaceRevenueEur:null,
    eligibleForAutomaticBudgetChange:false,spendAuthorized:false,
  });
  if(!input.report || input.report.provider!==input.provider || reportSpend===null){
    return out("MISSING_REPORT","A verified paid ad spend observation is required; do not assume zero.");
  }
  if(input.report.evidenceLevel==="INCOMPLETE" || input.report.warnings.some(w=>w.startsWith("INVALID_") || w==="CLICKS_EXCEED_IMPRESSIONS" || w==="CONVERSION_VALUE_WITHOUT_COUNT")){
    return out("INVALID_REPORT","Paid report contains incomplete or contradictory observations.");
  }
  if(!input.billing)return out("MISSING_BILLING","No independent provider billing evidence was supplied.");
  const b=input.billing;
  if(!b.fromVerifiedProviderBilling || !b.sourceReference){
    return out("UNVERIFIED_BILLING","Billing source must be authenticated and independently verified.");
  }
  if(b.currency!=="EUR")return out("CURRENCY_MISMATCH","Billing currency must be EUR; no automatic FX conversion.");
  if(b.provider!==input.provider||b.accountId!==input.accountId||b.campaignId!==input.campaignId
    ||b.period.start!==input.reportWindow.start||b.period.end!==input.reportWindow.end
    ||!validInterval(b.period)){
    return out("SCOPE_MISMATCH","Account, campaign and reporting window must match exactly.");
  }
  if(!b.settlementFinal)return out("UNSETTLED","Provider billing is not yet finalized.");
  if(!b.adSpendOnly)return out("NON_COMPARABLE_BILLING","Tax, refunds or provider adjustments must be separated from ad spend.");
  if(!positiveCents(reportSpend)||!positiveCents(billingSpend))return out("INVALID_AMOUNT","Spend values must be valid EUR cents.");
  const delta=Math.round((billingSpend-reportSpend)*100)/100;
  if(Math.abs(delta)>0.01)return out("SPEND_MISMATCH","Verified provider spend and billing disagree; human review required.",delta);
  return out("RECONCILED_FOR_REVIEW","EUR ad spend observations agree within one cent; still no sales attribution or action approval.",delta);
}
