import {assertPaidCampaignQuery,paidUtcWindow,providerNumber,requirePaidEUR,requirePaidCredentials,
  type PaidAdsReadOnlyClient,type PaidCampaignQuery,type PaidProviderAccess,type PaidCampaignObservation,
} from "../../use-cases/ads/paidCampaignCollectorContract";
import {PaidProviderReadError,isObject,paidGetJson} from "./paidTransport";

/** Google Ads API v25 SearchStream, strictly SELECT-only GAQL. */
export class GooglePaidCampaignClient implements PaidAdsReadOnlyClient {
  readonly provider="google_ads" as const;
  constructor(private readonly fetchImpl:typeof fetch=fetch){}
  async fetchCampaign(query:PaidCampaignQuery,access:PaidProviderAccess):Promise<PaidCampaignObservation>{
    if(query.provider!==this.provider)throw new Error("Google provider mismatch");
    assertPaidCampaignQuery(query);requirePaidCredentials(access);
    if(!access.developerToken||access.developerToken.length<8)
      throw new PaidProviderReadError("permission","Google Ads developer token not configured");
    if(access.managerCustomerId&&!/^[0-9]{5,25}$/.test(access.managerCustomerId))
      throw new PaidProviderReadError("rejected","Invalid Google manager account id");
    const url=new URL(`https://googleads.googleapis.com/v25/customers/${query.accountId}/googleAds:searchStream`);
    const gaql=`SELECT customer.id, customer.currency_code, campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id = ${query.campaignId} AND segments.date BETWEEN '${query.startDate}' AND '${query.endDate}'`;
    const payload=await paidGetJson(url,access,this.fetchImpl,"POST",{query:gaql},{
      "developer-token":access.developerToken,
      ...(access.managerCustomerId?{"login-customer-id":access.managerCustomerId}:{})});
    if(!Array.isArray(payload)||payload.length>3)
      throw new PaidProviderReadError("malformed","Google Ads report batches malformed");
    const rows:unknown[]=payload.flatMap(batch=>isObject(batch)&&Array.isArray(batch.results)?batch.results:[]);
    if(rows.length>1)throw new PaidProviderReadError("malformed","Google Ads reporting must use a single aggregate campaign row");
    const item=rows[0];
    if(item!==undefined&&(!isObject(item)||!isObject(item.customer)||!isObject(item.campaign)||!isObject(item.metrics)
      || String(item.campaign.id)!==query.campaignId
      || String(item.customer.id)!==query.accountId))
      throw new PaidProviderReadError("malformed","Google campaign identity or result malformed");
    const i=isObject(item)?item:null;
    if(i)requirePaidEUR((i.customer as Record<string,unknown>).currencyCode);
    const metrics=i?.metrics as Record<string,unknown>|undefined;
    const micros=providerNumber(metrics?.costMicros,"count");
    const rounded=micros===null?null:Math.round(micros/10000)/100;
    const warnings:string[]=item===undefined?["NO_CAMPAIGN_REPORT"]:[];
    if(micros!==null&&micros%10000!==0)warnings.push("EUR_MICRO_COST_ROUNDED_TO_CENTS");
    return {provider:this.provider,accountId:query.accountId,campaignId:query.campaignId,
      sourceReference:"google_ads.ads.v25_searchstream",currency:"EUR",window:paidUtcWindow(query),
      spendEur:rounded,impressions:providerNumber(metrics?.impressions,"count"),
      clicks:providerNumber(metrics?.clicks,"count"),providerReportedConversions:null,
      providerReportedConversionValueEur:null,warnings};
  }
}
