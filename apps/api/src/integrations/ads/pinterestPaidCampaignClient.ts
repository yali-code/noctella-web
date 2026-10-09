import {assertPaidCampaignQuery,paidUtcWindow,providerNumber,requirePaidEUR,requirePaidCredentials,
  type PaidAdsReadOnlyClient,type PaidCampaignQuery,type PaidProviderAccess,type PaidCampaignObservation,
} from "../../use-cases/ads/paidCampaignCollectorContract";
import {PaidProviderReadError,isObject,paidGetJson} from "./paidTransport";

/** Pinterest v5 paid Campaign Analytics, separate from organic Pins Analytics. */
export class PinterestPaidCampaignClient implements PaidAdsReadOnlyClient {
  readonly provider="pinterest_ads" as const;
  constructor(private readonly fetchImpl:typeof fetch=fetch){}
  async fetchCampaign(query:PaidCampaignQuery,access:PaidProviderAccess):Promise<PaidCampaignObservation>{
    if(query.provider!==this.provider)throw new Error("Pinterest paid provider mismatch");
    assertPaidCampaignQuery(query);requirePaidCredentials(access);
    const acc=await paidGetJson(new URL(`https://api.pinterest.com/v5/ad_accounts/${query.accountId}`),access,this.fetchImpl);
    if(!isObject(acc)||acc.id!==undefined&&String(acc.id)!==query.accountId)
      throw new PaidProviderReadError("malformed","Pinterest account response mismatch");
    requirePaidEUR(acc.currency);
    const url=new URL(`https://api.pinterest.com/v5/ad_accounts/${query.accountId}/campaigns/analytics`);
    url.searchParams.set("start_date",query.startDate);url.searchParams.set("end_date",query.endDate);
    url.searchParams.set("campaign_ids",query.campaignId);
    url.searchParams.set("columns","SPEND_IN_DOLLAR,TOTAL_IMPRESSION,TOTAL_CLICKTHROUGH");
    url.searchParams.set("granularity","TOTAL");
    const data=await paidGetJson(url,access,this.fetchImpl);
    if(!Array.isArray(data)||data.length>1)
      throw new PaidProviderReadError("malformed","Pinterest paid campaign response malformed");
    const item:unknown=data[0];
    if(item!==undefined&&(!isObject(item)||String(item.CAMPAIGN_ID)!==query.campaignId))
      throw new PaidProviderReadError("malformed","Pinterest campaign id mismatch");
    const m=isObject(item)?item:{};
    // SPEND_IN_DOLLAR is expressed in the advertiser account currency, checked EUR above.
    return {provider:this.provider,accountId:query.accountId,campaignId:query.campaignId,
      sourceReference:"pinterest_ads.ads.v5_campaign_analytics",currency:"EUR",window:paidUtcWindow(query),
      spendEur:providerNumber(m.SPEND_IN_DOLLAR,"money"),
      impressions:providerNumber(m.TOTAL_IMPRESSION,"count"),
      clicks:providerNumber(m.TOTAL_CLICKTHROUGH,"count"),
      providerReportedConversions:null,providerReportedConversionValueEur:null,
      warnings:item===undefined?["NO_CAMPAIGN_REPORT"]:[]};
  }
}
