import { sql } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { evaluateAdsPerformanceEvidence, type AdsMetricsProvider, type PaidMetricFacts } from "./adsPerformanceEvidence";
import { assessAdsOptimization } from "./adsOptimizationAdvice";

/**
 * ADS-006C: read-only adapter over the existing Analytics Agent's
 * analytics_metric_snapshots and analytics_runs. NEVER infer paid metrics
 * from organic social namespaces or marketplace click history.
 *
 * Reserved paid-collector contract: scopeType=external_ad_campaign,
 * scopeId=paid_<provider>:<campaignId>, metricNamespace=paid_<provider>,
 * sourceType=external_platform, sourceReference=<provider>.ads.*,
 * metadata paidAdsSource=true, provider, campaignId, currency=EUR,
 * windowSemantics=fixed_range, window={start,end}. A completed run is required.
 * NO paid collector writes these observations yet.
 */
export interface PaidSnapshotRow {
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly metricNamespace: string;
  readonly metricKey: string;
  readonly numericValue: number | null;
  readonly valueState: string;
  readonly unit: string;
  readonly sourceType: string;
  readonly sourceReference: string;
  readonly observedAt: string;
  readonly collectedAt: string;
  readonly metadataJson: string | null;
}
export type PaidReportStatus = "NOT_COLLECTED" | "UNTRUSTED_EVIDENCE" | "REPORT_AVAILABLE";
const KEYS = {
  paid_spend_eur: "eur",
  paid_impressions: "count",
  paid_clicks: "count",
  paid_provider_conversions: "count",
  paid_provider_conversion_value_eur: "eur",
} as const;
type MetricKey = keyof typeof KEYS;
type PaidMetadata = { window: { start: string; end: string }; currency: "EUR"; accountId: string | null };
const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
function parsedMetadata(row: PaidSnapshotRow, provider: AdsMetricsProvider, campaignId: string): PaidMetadata | null {
  try {
    const m: unknown = JSON.parse(row.metadataJson ?? "null");
    if (!isRecord(m) || m.paidAdsSource !== true || m.provider !== provider
      || m.campaignId !== campaignId || m.currency !== "EUR"
      || m.windowSemantics !== "fixed_range" || !isRecord(m.window)
      || typeof m.window.start !== "string" || typeof m.window.end !== "string"
      || !Number.isFinite(Date.parse(m.window.start))
      || !Number.isFinite(Date.parse(m.window.end))
      || Date.parse(m.window.start) >= Date.parse(m.window.end)
      || row.observedAt !== m.window.end) return null;
    // Legacy or malformed paid evidence can remain readable in Admin, but must
    // never be reconciled against billing without a verified stored account ID.
    const accountId = typeof m.accountId === "string" && /^[0-9]{5,25}$/.test(m.accountId)
      ? m.accountId : null;
    return { window: { start: m.window.start, end: m.window.end }, currency: "EUR", accountId };
  } catch { return null; }
}
function trustedRow(row: PaidSnapshotRow, provider: AdsMetricsProvider, campaignId: string): boolean {
  return row.scopeType === "external_ad_campaign"
    && row.scopeId === `paid_${provider}:${campaignId}`
    && row.metricNamespace === `paid_${provider}`
    && row.sourceType === "external_platform"
    && row.sourceReference.startsWith(`${provider}.ads.`)
    && row.runStatus === "completed"
    && typeof row.runId === "string" && row.runId.length > 0
    && Object.prototype.hasOwnProperty.call(KEYS, row.metricKey)
    && row.unit === KEYS[row.metricKey as MetricKey]
    && (row.valueState === "known" && row.numericValue !== null && Number.isFinite(row.numericValue)
      || row.valueState === "unknown" && row.numericValue === null)
    && parsedMetadata(row, provider, campaignId) !== null;
}
export function buildPaidCampaignReadout(
  provider: AdsMetricsProvider,
  campaignId: string,
  observations: readonly PaidSnapshotRow[],
) {
  const base = { provider, campaignId, accountId: null as string | null, source: "EXISTING_ANALYTICS_SNAPSHOTS" as const,
    marketplaceAttributionVerified: false as const, spendAuthorized: false as const };
  if (!observations.length) {
    return { ...base, status: "NOT_COLLECTED" as PaidReportStatus, evidence: null, advice: null };
  }
  // Do not fall back silently to an older run after discovering invalid evidence.
  if (!observations.every(r => trustedRow(r, provider, campaignId))) {
    return { ...base, status: "UNTRUSTED_EVIDENCE" as PaidReportStatus, evidence: null, advice: null };
  }
  const sorted = observations.slice().sort((a,b) =>
    b.observedAt.localeCompare(a.observedAt)
    || b.collectedAt.localeCompare(a.collectedAt)
    || (b.runId ?? "").localeCompare(a.runId ?? ""));
  const newest = sorted[0]!;
  const group = sorted.filter(r => r.runId === newest.runId && r.observedAt === newest.observedAt);
  const first = parsedMetadata(newest, provider, campaignId)!;
  if (group.some(r =>
    r.sourceReference !== newest.sourceReference
    || JSON.stringify(parsedMetadata(r, provider, campaignId)) !== JSON.stringify(first)
  ) || new Set(group.map(r=>r.metricKey)).size !== group.length) {
    return { ...base, status: "UNTRUSTED_EVIDENCE" as PaidReportStatus, evidence: null, advice: null };
  }
  const metrics = new Map(group.map(r=>[r.metricKey, r.numericValue] as const));
  const get = (k: MetricKey): number | null => metrics.get(k) ?? null;
  const facts: PaidMetricFacts = {
    provider, currency: "EUR",
    periodStart: first.window.start, periodEnd: first.window.end,
    spendEur: get("paid_spend_eur"),
    impressions: get("paid_impressions"),
    clicks: get("paid_clicks"),
    providerReportedConversions: get("paid_provider_conversions"),
    providerReportedConversionValueEur: get("paid_provider_conversion_value_eur"),
    marketplaceConfirmedOrders: null,
  };
  const evidence = evaluateAdsPerformanceEvidence(facts);
  return { ...base, status: "REPORT_AVAILABLE" as PaidReportStatus,
    accountId: first.accountId, period: { ...first.window }, sourceReference: newest.sourceReference,
    collectedAt: newest.collectedAt, evidence, advice: assessAdsOptimization(evidence) };
}

/** Parameterized, bounded and restricted to one exact paid campaign scope. */
export async function readPaidCampaignReport(
  db: DbClient, provider: AdsMetricsProvider, campaignId: string,
) {
  if (!/^[0-9]{5,25}$/.test(campaignId)) {
    throw new Error("Invalid provider campaign identifier");
  }
  const scopeId = `paid_${provider}:${campaignId}`;
  const namespace = `paid_${provider}`;
  const observations = await db.all(sql`
    SELECT m.run_id AS "runId", a.status AS "runStatus",
      m.scope_type AS "scopeType", m.scope_id AS "scopeId",
      m.metric_namespace AS "metricNamespace", m.metric_key AS "metricKey",
      m.numeric_value AS "numericValue", m.value_state AS "valueState",
      m.unit AS "unit", m.source_type AS "sourceType",
      m.source_reference AS "sourceReference", m.observed_at AS "observedAt",
      m.collected_at AS "collectedAt", m.metadata_json AS "metadataJson"
    FROM analytics_metric_snapshots m
    INNER JOIN analytics_runs a ON a.id = m.run_id
      AND a.source_type = 'external_platform'
      AND a.source_reference = m.source_reference
    WHERE m.scope_type = 'external_ad_campaign'
      AND m.scope_id = ${scopeId} AND m.metric_namespace = ${namespace}
      AND m.source_type = 'external_platform'
    ORDER BY m.observed_at DESC, m.collected_at DESC
    LIMIT 100
  `) as PaidSnapshotRow[];
  return buildPaidCampaignReadout(provider, campaignId, observations);
}
