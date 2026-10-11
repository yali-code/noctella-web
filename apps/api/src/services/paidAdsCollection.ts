import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import { createSqliteAnalyticsSnapshotRepository } from "../repositories/analytics/analyticsSnapshotsSqlite";
import { assertPaidObservation, assertPaidCampaignQuery, requirePaidCredentials,
  type PaidCampaignObservation,type PaidCampaignQuery,type PaidAdsReadOnlyClient,type PaidProviderAccess,
} from "../use-cases/ads/paidCampaignCollectorContract";

/** Stored paid evidence conflicts with a new provider observation; nothing was written. */
export class PaidEvidenceConflictError extends Error {
  constructor(readonly code:"PAID_PROVIDER_RESTATEMENT"|"PAID_WINDOW_END_CONFLICT",message:string){
    super(message);this.name="PaidEvidenceConflictError";
  }
}

/**
 * ADS-006F: strictly opt-in, backend-only paid analytics collection.
 * This function has no scheduler, route or public credential creation. It is
 * not invoked by existing background jobs or production deploys.
 */
export async function collectPaidCampaignEvidence(
  db:DbClient, client:PaidAdsReadOnlyClient, query:PaidCampaignQuery,access:PaidProviderAccess,
  options:{ readonly explicitReadApproval:boolean;readonly explicitSnapshotWriteApproval:boolean;
    readonly now?:Date }={explicitReadApproval:false,explicitSnapshotWriteApproval:false},
) {
  if(!options.explicitReadApproval) throw new Error("Paid provider read permission has not been approved");
  if(client.provider!==query.provider)throw new Error("Provider mismatch");
  assertPaidCampaignQuery(query);
  requirePaidCredentials(access);
  const observation=await client.fetchCampaign(query,access);
  assertPaidObservation(observation,query);
  // The UTC date check above cannot see account-local days: a day still running in the provider
  // account's time zone would otherwise be stored as a complete window.
  if(Date.parse(observation.window.end)>(options.now??new Date()).getTime()){
    throw new Error("Paid reporting window has not ended in the provider account time zone");
  }
  if(!options.explicitSnapshotWriteApproval) {
    return {status:"PREVIEW_ONLY" as const,provider:query.provider,campaignId:query.campaignId,
      evidence:observation,run:null,spendAuthorized:false as const};
  }
  return {...storeVerifiedPaidCampaignEvidence(db,query,observation,options.now),status:"STORED" as const};
}

/** Requires caller-trusted approval; never accept a client-supplied authorization flag through HTTP. */
export function storeVerifiedPaidCampaignEvidence(
  db:DbClient, query:PaidCampaignQuery, o:PaidCampaignObservation, now=new Date(),
){
  assertPaidObservation(o,query);
  if([o.spendEur,o.impressions,o.clicks,o.providerReportedConversions,o.providerReportedConversionValueEur].every(v=>v===null)) {
    throw new Error("No paid metrics supplied; refusing to persist empty evidence");
  }
  const r=createSqliteAnalyticsSnapshotRepository(db);
  const key=`paid:${o.provider}:${o.accountId}:${o.campaignId}:${o.sourceReference}:${o.window.start}:${o.window.end}`;
  const entries=[
    ["paid_spend_eur",o.spendEur,"eur"],["paid_impressions",o.impressions,"count"],
    ["paid_clicks",o.clicks,"count"],["paid_provider_conversions",o.providerReportedConversions,"count"],
    ["paid_provider_conversion_value_eur",o.providerReportedConversionValueEur,"eur"],
  ] as const;
  const scopeId=`paid_${o.provider}:${o.campaignId}`,namespace=`paid_${o.provider}`;
  const prior=r.findRun(key);
  if(prior?.status==="completed"){
    // Exact replay is idempotent; a provider restatement of an already stored window is never
    // silently ignored (stale spend) nor silently overwritten (lost history): human review.
    const stored=r.listRunMetricValues(prior.id);
    if(entries.some(([metricKey,value])=>!stored.has(metricKey)||stored.get(metricKey)!==value)){
      throw new PaidEvidenceConflictError("PAID_PROVIDER_RESTATEMENT","Provider metrics changed for an already stored paid window; human review required");
    }
    return {run:prior,replayed:true,spendAuthorized:false as const};
  }
  // Snapshot identity is (scope, namespace, metric, observedAt=window end, source): another window
  // ending at the same instant would be dropped by the idempotent insert while its run still read
  // "completed". Refuse instead of recording a run without evidence.
  if(r.listSnapshotRunIdsAt("external_ad_campaign",scopeId,namespace,o.window.end,o.sourceReference).some(id=>id!==prior?.id)){
    throw new PaidEvidenceConflictError("PAID_WINDOW_END_CONFLICT","A different paid window ending at the same time is already stored for this campaign");
  }
  const run={id:randomUUID(),runType:`paid_${o.provider}_campaign_metrics`,sourceType:"external_platform",
    sourceReference:o.sourceReference,idempotencyKey:key,observedAt:o.window.end,startedAt:now.toISOString()};
  const rows=entries.map(([metricKey,numericValue,unit])=>({
    scopeType:"external_ad_campaign",scopeId,
    metricNamespace:namespace,metricKey,numericValue,textValue:null,
    valueState:numericValue===null?"unknown":"known",unit,
    metadata:{paidAdsSource:true,provider:o.provider,accountId:o.accountId,
      campaignId:o.campaignId,currency:"EUR",windowSemantics:"fixed_range",
      window:o.window,reportingTimeZone:o.reportingTimeZone,
      reportDates:{start:query.startDate,end:query.endDate}},
  }));
  return {run:r.writeCompletedRun(run,now.toISOString(),now.toISOString(),rows),
    replayed:false,spendAuthorized:false as const};
}
