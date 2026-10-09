import type { AdsMetricsProvider } from "./adsPerformanceEvidence";

/** Provider-only evidence; not marketplace sales. No browser/user token is accepted here. */
export interface PaidCampaignQuery {
  readonly provider: AdsMetricsProvider;
  readonly accountId: string;
  readonly campaignId: string;
  readonly startDate: string; // UTC YYYY-MM-DD, inclusive
  readonly endDate: string; // UTC YYYY-MM-DD, inclusive
}
export interface PaidCampaignObservation {
  readonly provider: AdsMetricsProvider;
  readonly accountId: string;
  readonly campaignId: string;
  readonly sourceReference: string;
  readonly currency: "EUR";
  /** Exclusive UTC end, at midnight following endDate. */
  readonly window: { readonly start: string; readonly end: string };
  readonly spendEur: number | null;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly providerReportedConversions: number | null;
  readonly providerReportedConversionValueEur: number | null;
  readonly warnings: readonly string[];
}
export interface PaidAdsReadOnlyClient {
  readonly provider: AdsMetricsProvider;
  fetchCampaign(query: PaidCampaignQuery, auth: PaidProviderAccess): Promise<PaidCampaignObservation>;
}
/** Caller must obtain this via separately approved paid-ad provider OAuth; never organic social credentials. */
export interface PaidProviderAccess {
  readonly accessToken: string;
  readonly developerToken?: string; // Google Ads only
  readonly managerCustomerId?: string; // Google Ads only
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function assertPaidCampaignQuery(query: PaidCampaignQuery): void {
  for (const id of [query.accountId, query.campaignId]) {
    if (!/^[0-9]{5,25}$/.test(id)) throw new Error("Invalid paid account or campaign identifier");
  }
  for (const date of [query.startDate, query.endDate]) {
    if (!datePattern.test(date) || new Date(date+"T00:00:00.000Z").toISOString().slice(0,10)!==date) {
      throw new Error("Invalid UTC paid campaign date");
    }
  }
  const start=Date.parse(query.startDate+"T00:00:00.000Z");
  const end=Date.parse(query.endDate+"T00:00:00.000Z");
  if (end<start || end-start>30*86400000 || end>=Date.now()) {
    throw new Error("Paid reporting window must be complete, in the past and at most 31 days");
  }
}
export function paidUtcWindow(query: PaidCampaignQuery) {
  assertPaidCampaignQuery(query);
  const end = new Date(Date.parse(query.endDate+"T00:00:00.000Z")+86400000).toISOString();
  return {start:query.startDate+"T00:00:00.000Z",end};
}
export function providerNumber(value: unknown, kind: "money"|"count"): number|null {
  if(value===null||value===undefined) return null;
  if(typeof value!=="string" && typeof value!=="number")throw new Error("Invalid provider metric");
  if(typeof value==="string" && !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error("Invalid provider numeric text");
  const n=Number(value);
  if(!Number.isFinite(n)||n<0 || (kind==="count"&&!Number.isSafeInteger(n)))throw new Error("Invalid provider metric magnitude");
  if(kind==="money" && (!Number.isSafeInteger(Math.round(n*100))||Math.abs(n*100-Math.round(n*100))>0.00001)) throw new Error("Invalid EUR cents from provider");
  return n;
}
export function requirePaidEUR(currency: unknown): asserts currency is "EUR" {
  if(currency!=="EUR") throw new Error("Paid ad account currency must be EUR; automatic FX conversion disabled");
}
export function assertPaidObservation(o:PaidCampaignObservation,q:PaidCampaignQuery):void {
  const w=paidUtcWindow(q);
  if(o.provider!==q.provider || o.accountId!==q.accountId || o.campaignId!==q.campaignId
    || o.window.start!==w.start||o.window.end!==w.end||o.currency!=="EUR"
    || !o.sourceReference.startsWith(q.provider+".ads.")
    || !Array.isArray(o.warnings))throw new Error("Paid observation provenance mismatch");
  for(const [kind,value] of [["money",o.spendEur],["count",o.impressions],["count",o.clicks],
    ["count",o.providerReportedConversions],["money",o.providerReportedConversionValueEur]] as const) {
    if(value!==null && providerNumber(value,kind)!==value) throw new Error("Untrusted paid numeric evidence");
  }
  if(o.providerReportedConversionValueEur!==null&&o.providerReportedConversions===null)throw new Error("Unpaired provider conversion value");
}
export function requirePaidCredentials(access:PaidProviderAccess):void {
  if(typeof access.accessToken!=="string" || access.accessToken.trim().length<8) throw new Error("Paid account access not configured");
}
