import type { AdsMetricsProvider } from "./adsPerformanceEvidence";
import { zonedTimeToUtc } from "../media-planning/planner";

/** Provider-only evidence; not marketplace sales. No browser/user token is accepted here. */
export interface PaidCampaignQuery {
  readonly provider: AdsMetricsProvider;
  readonly accountId: string;
  readonly campaignId: string;
  readonly startDate: string; // provider reporting date YYYY-MM-DD, inclusive
  readonly endDate: string; // provider reporting date YYYY-MM-DD, inclusive
}
export interface PaidCampaignObservation {
  readonly provider: AdsMetricsProvider;
  readonly accountId: string;
  readonly campaignId: string;
  readonly sourceReference: string;
  readonly currency: "EUR";
  /**
   * IANA zone in which the provider buckets reporting dates (Meta: ad account timezone_name,
   * Google Ads: customer.time_zone, Pinterest: documented UTC). Verified, never assumed.
   */
  readonly reportingTimeZone: string;
  /** UTC instants of local midnight at startDate and (exclusive) the midnight after endDate, in reportingTimeZone. */
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
  if (end<start || end-start>30*86400000 || end+86400000>Date.now()) {
    throw new Error("Paid reporting window must be complete, in the past and at most 31 days");
  }
}
/** Provider-supplied reporting time zone must be a real IANA zone; otherwise the window is unknowable. */
export function assertReportingTimeZone(timeZone: unknown): asserts timeZone is string {
  if(typeof timeZone!=="string"||!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(timeZone))throw new Error("Paid provider reporting time zone missing or invalid");
  try { new Intl.DateTimeFormat("en-US",{timeZone}); } catch { throw new Error("Paid provider reporting time zone missing or invalid"); }
}
/**
 * Exact instants covered by the provider's account-local reporting dates (DST-safe). A provider
 * "day" is the account's calendar day, so labelling it as a UTC day would misstate provenance and
 * break reconciliation against account-local billing periods.
 */
export function paidReportingWindow(query: PaidCampaignQuery, timeZone: string) {
  assertPaidCampaignQuery(query);
  assertReportingTimeZone(timeZone);
  const next = new Date(Date.parse(query.endDate+"T00:00:00.000Z")+86400000).toISOString().slice(0,10);
  return {start:zonedTimeToUtc(query.startDate,0,0,timeZone),end:zonedTimeToUtc(next,0,0,timeZone)};
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
  const w=paidReportingWindow(q,o.reportingTimeZone);
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
