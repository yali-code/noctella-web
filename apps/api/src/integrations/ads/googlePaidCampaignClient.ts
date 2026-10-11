import {assertPaidCampaignQuery,paidReportingWindow,assertReportingTimeZone,providerNumber,requirePaidEUR,requirePaidCredentials,
  type PaidAdsReadOnlyClient,type PaidCampaignQuery,type PaidProviderAccess,type PaidCampaignObservation,
} from "../../use-cases/ads/paidCampaignCollectorContract";
import {PaidProviderReadError,isObject,paidGetJson} from "./paidTransport";

/** Fail closed when Google sends an unexpected SearchStream batch shape. */
function readSearchStreamRows(payload:unknown):unknown[]{
  if(!Array.isArray(payload)||payload.length>3
    || payload.some(batch=>!isObject(batch)||!Array.isArray(batch.results)))
    throw new PaidProviderReadError("malformed","Google Ads SearchStream response malformed");
  return payload.flatMap((batch:Record<string,unknown>)=>batch.results as unknown[]);
}
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
    const headers={
      "developer-token":access.developerToken,
      ...(access.managerCustomerId?{"login-customer-id":access.managerCustomerId}:{}),
    };
    // An empty campaign report does not identify a customer or prove its currency.
    // Verify the account independently BEFORE requesting its campaign metrics.
    const accountQuery="SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1";
    const rawAccount=await paidGetJson(url,access,this.fetchImpl,"POST",{query:accountQuery},headers);
    const accountRows=readSearchStreamRows(rawAccount);
    if(accountRows.length!==1||!isObject(accountRows[0])||!isObject(accountRows[0].customer)
      || String(accountRows[0].customer.id)!==query.accountId)
      throw new PaidProviderReadError("malformed","Google Ads customer identity not verified");
    requirePaidEUR(accountRows[0].customer.currencyCode);
    // segments.date is a customer-local day (customer.time_zone), not a UTC day.
    const reportingTimeZone=accountRows[0].customer.timeZone;
    try{assertReportingTimeZone(reportingTimeZone);}catch{throw new PaidProviderReadError("malformed","Google Ads customer time zone missing or invalid");}

    const gaql=`SELECT customer.id, customer.currency_code, campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id = ${query.campaignId} AND segments.date BETWEEN '${query.startDate}' AND '${query.endDate}'`;
    const payload=await paidGetJson(url,access,this.fetchImpl,"POST",{query:gaql},headers);
    const rows=readSearchStreamRows(payload);
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
      sourceReference:"google_ads.ads.v25_searchstream",currency:"EUR",reportingTimeZone,window:paidReportingWindow(query,reportingTimeZone),
      spendEur:rounded,impressions:providerNumber(metrics?.impressions,"count"),
      clicks:providerNumber(metrics?.clicks,"count"),providerReportedConversions:null,
      providerReportedConversionValueEur:null,warnings};
  }
}
