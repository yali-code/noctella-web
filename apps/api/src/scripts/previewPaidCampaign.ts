import { MetaPaidCampaignClient } from "../integrations/ads/metaPaidCampaignClient";
import { GooglePaidCampaignClient } from "../integrations/ads/googlePaidCampaignClient";
import { PinterestPaidCampaignClient } from "../integrations/ads/pinterestPaidCampaignClient";
import {assertPaidCampaignQuery,type PaidCampaignQuery,type PaidProviderAccess,type PaidAdsReadOnlyClient} from "../use-cases/ads/paidCampaignCollectorContract";

/**
 * Unscheduled read-only preview. Does NOT import/create the ERP database and
 * does NOT persist analytics observations or initiate paid advertising.
 *
 * Only called manually after separately approved paid ads credentials exist.
 */
export async function previewPaidCampaignFromEnv(
  env:Record<string,string|undefined>=process.env,
  fetchImpl:typeof fetch=fetch,
){
  if(env.NOCTELLA_PAID_ADS_PREVIEW_ACK!=="I_AUTHORIZE_PAID_READ_ONLY") {
    throw new Error("Explicit paid API reporting read authorization is required");
  }
  const provider=env.NOCTELLA_PAID_ADS_PROVIDER;
  if(!["meta","google_ads","pinterest_ads"].includes(provider??"")){
    throw new Error("Choose a supported paid provider");
  }
  const p=provider as PaidCampaignQuery["provider"];
  const accountId=p==="meta"?env.NOCTELLA_META_AD_ACCOUNT_ID:
    p==="google_ads"?env.NOCTELLA_GOOGLE_ADS_CUSTOMER_ID:env.NOCTELLA_PINTEREST_AD_ACCOUNT_ID;
  const token=p==="meta"?env.NOCTELLA_META_AD_ACCESS_TOKEN:
    p==="google_ads"?env.NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN:env.NOCTELLA_PINTEREST_AD_ACCESS_TOKEN;
  const query:PaidCampaignQuery={
    provider:p,
    accountId:accountId??"",campaignId:env.NOCTELLA_PAID_ADS_CAMPAIGN_ID??"",
    startDate:env.NOCTELLA_PAID_ADS_START_DATE??"",endDate:env.NOCTELLA_PAID_ADS_END_DATE??"",
  };
  assertPaidCampaignQuery(query);
  const access:PaidProviderAccess={
    accessToken:token??"",
    ...(p==="google_ads"?{
      developerToken:env.NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN,
      managerCustomerId:env.NOCTELLA_GOOGLE_ADS_MANAGER_CUSTOMER_ID,
    }:{}),
  };
  const clients:Record<PaidCampaignQuery["provider"],PaidAdsReadOnlyClient>={
    meta:new MetaPaidCampaignClient(fetchImpl),
    google_ads:new GooglePaidCampaignClient(fetchImpl),
    pinterest_ads:new PinterestPaidCampaignClient(fetchImpl),
  };
  const evidence=await clients[p].fetchCampaign(query,access);
  // Safe-to-display fields only, never tokens or raw response bodies.
  return {mode:"READ_ONLY_PREVIEW" as const,provider:p,currency:evidence.currency,
    window:evidence.window,spendEur:evidence.spendEur,
    impressions:evidence.impressions,clicks:evidence.clicks,
    reportedConversions:evidence.providerReportedConversions,
    warnings:evidence.warnings,storagePerformed:false as const,
    campaignModified:false as const,spendAuthorized:false as const};
}
async function main(){
  try{
    const result=await previewPaidCampaignFromEnv();
    console.log(JSON.stringify(result,null,2));
  }catch {
    // Never print raw vendor exception bodies, SDK details or secrets.
    console.error("Paid reporting preview denied or failed. Check configuration and permissions.");
    process.exitCode=1;
  }
}
if(require.main===module)void main();
