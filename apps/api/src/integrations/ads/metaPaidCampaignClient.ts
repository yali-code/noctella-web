import {assertPaidCampaignQuery,paidReportingWindow,assertReportingTimeZone,providerNumber,requirePaidEUR,requirePaidCredentials,
  type PaidAdsReadOnlyClient,type PaidCampaignQuery,type PaidProviderAccess,type PaidCampaignObservation,
} from "../../use-cases/ads/paidCampaignCollectorContract";
import {PaidProviderReadError,isObject,paidGetJson} from "./paidTransport";

/** Meta Marketing API v26.0; strictly READ ONLY /insights at campaign level. */
export class MetaPaidCampaignClient implements PaidAdsReadOnlyClient {
  readonly provider="meta" as const;
  constructor(private readonly fetchImpl:typeof fetch=fetch){}
  async fetchCampaign(query:PaidCampaignQuery,access:PaidProviderAccess):Promise<PaidCampaignObservation>{
    if(query.provider!==this.provider)throw new Error("Meta provider mismatch");
    assertPaidCampaignQuery(query);requirePaidCredentials(access);
    const account = new URL(`https://graph.facebook.com/v26.0/act_${query.accountId}`);
    account.searchParams.set("fields","currency,account_id,timezone_name");
    const acc=await paidGetJson(account,access,this.fetchImpl);
    if(!isObject(acc))throw new PaidProviderReadError("malformed","Meta ad account response malformed");
    if(String(acc.account_id)!==query.accountId)
      throw new PaidProviderReadError("malformed","Meta account identity mismatch");
    requirePaidEUR(acc.currency);
    // Meta Insights dates are ad-account-local days (timezone_name), not UTC days.
    const reportingTimeZone=acc.timezone_name;
    try{assertReportingTimeZone(reportingTimeZone);}catch{throw new PaidProviderReadError("malformed","Meta ad account time zone missing or invalid");}
    const url=new URL(`https://graph.facebook.com/v26.0/act_${query.accountId}/insights`);
    url.searchParams.set("level","campaign");
    url.searchParams.set("fields","campaign_id,spend,impressions,clicks,date_start,date_stop");
    url.searchParams.set("filtering",JSON.stringify([{field:"campaign.id",operator:"EQUAL",value:query.campaignId}]));
    url.searchParams.set("time_range",JSON.stringify({since:query.startDate,until:query.endDate}));
    url.searchParams.set("limit","10");
    const result=await paidGetJson(url,access,this.fetchImpl);
    if(!isObject(result)||!Array.isArray(result.data)||result.data.length>1
      || (isObject(result.paging)&&Boolean(result.paging.next)))throw new PaidProviderReadError("malformed","Meta paid campaign insights response untrusted");
    const row:unknown=result.data[0];
    if(row!==undefined&&(!isObject(row)||String(row.campaign_id)!==query.campaignId
      || row.date_start!==query.startDate || row.date_stop!==query.endDate))
      throw new PaidProviderReadError("malformed","Meta campaign or window mismatch");
    const m=isObject(row)?row:{};
    return {provider:this.provider,accountId:query.accountId,campaignId:query.campaignId,
      sourceReference:"meta.ads.graph_v26_insights",currency:"EUR",reportingTimeZone,window:paidReportingWindow(query,reportingTimeZone),
      spendEur:providerNumber(m.spend,"money"),impressions:providerNumber(m.impressions,"count"),
      clicks:providerNumber(m.clicks,"count"),providerReportedConversions:null,
      providerReportedConversionValueEur:null,warnings:row===undefined?["NO_CAMPAIGN_REPORT"]:[]};
  }
}
