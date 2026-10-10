import {assertPaidCampaignQuery,paidReportingWindow,providerNumber,requirePaidEUR,requirePaidCredentials,
  type PaidAdsReadOnlyClient,type PaidCampaignQuery,type PaidProviderAccess,type PaidCampaignObservation,
} from "../../use-cases/ads/paidCampaignCollectorContract";
import {PaidProviderReadError,isObject,paidGetJson} from "./paidTransport";

/**
 * Pinterest v5 documents analytics start_date/end_date as UTC dates (unlike Meta/Google, which
 * bucket by account-local day). To be re-confirmed against the live account during staging.
 */
export const PINTEREST_REPORTING_TIME_ZONE="UTC";

/** Pinterest v5 paid Campaign Analytics, separate from organic Pins Analytics. */
export class PinterestPaidCampaignClient implements PaidAdsReadOnlyClient {
  readonly provider="pinterest_ads" as const;
  constructor(private readonly fetchImpl:typeof fetch=fetch){}
  async fetchCampaign(query:PaidCampaignQuery,access:PaidProviderAccess,now:Date=new Date()):Promise<PaidCampaignObservation>{
    if(query.provider!==this.provider)throw new Error("Pinterest paid provider mismatch");
    assertPaidCampaignQuery(query,now);requirePaidCredentials(access);
    const acc=await paidGetJson(new URL(`https://api.pinterest.com/v5/ad_accounts/${query.accountId}`),access,this.fetchImpl);
    if(!isObject(acc)||String(acc.id)!==query.accountId)
      throw new PaidProviderReadError("malformed","Pinterest account response mismatch");
    requirePaidEUR(acc.currency);
    const url=new URL(`https://api.pinterest.com/v5/ad_accounts/${query.accountId}/campaigns/analytics`);
    url.searchParams.set("start_date",query.startDate);url.searchParams.set("end_date",query.endDate);
    url.searchParams.set("campaign_ids",query.campaignId);
    url.searchParams.set("columns","SPEND_IN_MICRO_DOLLAR,TOTAL_IMPRESSION,TOTAL_CLICKTHROUGH");
    url.searchParams.set("granularity","TOTAL");
    const data=await paidGetJson(url,access,this.fetchImpl);
    if(!Array.isArray(data)||data.length>1)
      throw new PaidProviderReadError("malformed","Pinterest paid campaign response malformed");
    const item:unknown=data[0];
    if(item!==undefined&&(!isObject(item)||String(item.CAMPAIGN_ID)!==query.campaignId))
      throw new PaidProviderReadError("malformed","Pinterest campaign id mismatch");
    const m=isObject(item)?item:{};
    // Pinterest documents MICRO_DOLLAR values as micro-units in the advertiser's
    // profile currency. Account currency was independently verified as EUR.
    const micros=providerNumber(m.SPEND_IN_MICRO_DOLLAR,"count");
    const spendEur=micros===null?null:Math.round(micros/10000)/100;
    const warnings:string[]=item===undefined?["NO_CAMPAIGN_REPORT"]:[];
    if(micros!==null&&micros%10000!==0)warnings.push("EUR_MICRO_COST_ROUNDED_TO_CENTS");
    return {provider:this.provider,accountId:query.accountId,campaignId:query.campaignId,
      sourceReference:"pinterest_ads.ads.v5_campaign_analytics",currency:"EUR",reportingTimeZone:PINTEREST_REPORTING_TIME_ZONE,window:paidReportingWindow(query,PINTEREST_REPORTING_TIME_ZONE,now),
      spendEur,
      impressions:providerNumber(m.TOTAL_IMPRESSION,"count"),
      clicks:providerNumber(m.TOTAL_CLICKTHROUGH,"count"),
      providerReportedConversions:null,providerReportedConversionValueEur:null,
      warnings};
  }
}
