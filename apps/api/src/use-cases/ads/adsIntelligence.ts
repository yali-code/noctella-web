import { sql } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { buildPaidCampaignReadout, type PaidSnapshotRow } from "./adsPaidCampaignRead";
import type { AdsMetricsProvider } from "./adsPerformanceEvidence";

/**
 * ADS-007 Ads Intelligence: deterministic, READ-ONLY analysis of stored paid provider evidence
 * (analytics_metric_snapshots, paid_<provider> namespaces only - never organic social metrics).
 * Every window passes the same trust rules as the ADS-006C readout. Recommendations are advisory:
 * no campaign, budget, bid or spend change is ever made or authorized. Provider-reported
 * conversions are never marketplace sales; no marketplace ROAS is computed.
 */

/** Minimum history and volume before a rule may flag an anomaly (avoids noise on tiny samples). */
export const ADS_INTELLIGENCE_RULES = Object.freeze({
  minBaselineWindows: 2,
  spendSpikeRatio: 2,
  minSpendSpikeEurPerDay: 5,
  ctrDropRatio: 0.5,
  minImpressionsForCtr: 1000,
  cpcSpikeRatio: 2,
  minClicksForCpc: 20,
  maxWindows: 12,
});

export interface PaidWindowMetrics {
  readonly period: { readonly start: string; readonly end: string };
  readonly sourceReference: string;
  readonly spendEur: number | null;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly providerReportedConversions: number | null;
  readonly providerReportedConversionValueEur: number | null;
}
export type MetricGap = "SPEND_UNKNOWN" | "IMPRESSIONS_UNKNOWN" | "CLICKS_UNKNOWN" | "NO_IMPRESSIONS" | "NO_CLICKS" | "PROVIDER_CONVERSIONS_NOT_COLLECTED";
export interface PaidWindowRates {
  readonly days: number;
  readonly spendEurPerDay: number | null;
  readonly cpcEur: number | null;
  readonly cpmEur: number | null;
  readonly ctr: number | null;
  readonly costPerProviderConversionEur: number | null;
  readonly gaps: readonly MetricGap[];
}
export type AdsAnomalyCode = "SPEND_SPIKE" | "CTR_DROP" | "CPC_SPIKE" | "SPEND_WITHOUT_DELIVERY" | "DELIVERY_WITHOUT_SPEND" | "CLICKS_EXCEED_IMPRESSIONS";
export type AdsRecommendationCode =
  | "REVIEW_DATA_QUALITY" | "INVESTIGATE_SPEND_SPIKE" | "REVIEW_CREATIVE_AND_TARGETING"
  | "REVIEW_BID_AND_COMPETITION" | "COLLECT_MORE_EVIDENCE" | "CONTINUE_MONITORING";

const round = (value: number, digits: number) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const median = (values: readonly number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** CPC/CPM/CTR only from known, non-zero denominators; a missing input is reported, never zero-filled. */
export function derivePaidRates(w: PaidWindowMetrics): PaidWindowRates {
  const days = Math.max(1, Math.round((Date.parse(w.period.end) - Date.parse(w.period.start)) / 86_400_000));
  const gaps: MetricGap[] = [];
  if (w.spendEur === null) gaps.push("SPEND_UNKNOWN");
  if (w.impressions === null) gaps.push("IMPRESSIONS_UNKNOWN"); else if (w.impressions === 0) gaps.push("NO_IMPRESSIONS");
  if (w.clicks === null) gaps.push("CLICKS_UNKNOWN"); else if (w.clicks === 0) gaps.push("NO_CLICKS");
  if (w.providerReportedConversions === null) gaps.push("PROVIDER_CONVERSIONS_NOT_COLLECTED");
  const spend = w.spendEur;
  return {
    days,
    spendEurPerDay: spend === null ? null : round(spend / days, 2),
    cpcEur: spend !== null && w.clicks ? round(spend / w.clicks, 4) : null,
    cpmEur: spend !== null && w.impressions ? round((spend / w.impressions) * 1000, 4) : null,
    ctr: w.clicks !== null && w.impressions ? round(w.clicks / w.impressions, 6) : null,
    costPerProviderConversionEur: spend !== null && w.providerReportedConversions ? round(spend / w.providerReportedConversions, 4) : null,
    gaps,
  };
}

/** Relative change; null when either side is unknown or the baseline is zero. */
const change = (current: number | null, previous: number | null) =>
  current === null || previous === null || previous === 0 ? null : round((current - previous) / previous, 4);

export function analyzePaidCampaignWindows(
  provider: AdsMetricsProvider, campaignId: string, windows: readonly PaidWindowMetrics[],
  context: { readonly untrustedWindows?: number; readonly overlappingWindowsExcluded?: number } = {},
) {
  const R = ADS_INTELLIGENCE_RULES;
  // Newest first; only non-overlapping windows are comparable as a time series.
  const ordered = [...windows].sort((a, b) => b.period.end.localeCompare(a.period.end));
  const series: PaidWindowMetrics[] = [];
  let overlapping = context.overlappingWindowsExcluded ?? 0;
  for (const w of ordered) {
    if (series.length && Date.parse(w.period.end) > Date.parse(series[series.length - 1]!.period.start)) { overlapping += 1; continue; }
    if (series.length < R.maxWindows) series.push(w);
  }
  const analysed = series.map((w) => ({ ...w, rates: derivePaidRates(w) }));
  const [latest, previous, ...older] = analysed;
  const baseline = [previous, ...older].filter((w): w is NonNullable<typeof w> => Boolean(w));
  const anomalies: { code: AdsAnomalyCode; detail: string }[] = [];
  if (latest) {
    const r = latest.rates;
    if (latest.clicks !== null && latest.impressions !== null && latest.clicks > latest.impressions) anomalies.push({ code: "CLICKS_EXCEED_IMPRESSIONS", detail: "Provider reports more clicks than impressions." });
    if ((latest.spendEur ?? 0) > 0 && latest.impressions === 0) anomalies.push({ code: "SPEND_WITHOUT_DELIVERY", detail: "Spend recorded with zero impressions." });
    if (latest.spendEur === 0 && (latest.impressions ?? 0) > 0) anomalies.push({ code: "DELIVERY_WITHOUT_SPEND", detail: "Impressions recorded with zero spend; verify billing and reporting." });
    if (baseline.length >= R.minBaselineWindows) {
      const known = (pick: (rates: PaidWindowRates) => number | null) => baseline.map((w) => pick(w.rates)).filter((v): v is number => v !== null);
      const spendBase = known((x) => x.spendEurPerDay), ctrBase = known((x) => x.ctr), cpcBase = known((x) => x.cpcEur);
      if (r.spendEurPerDay !== null && spendBase.length >= R.minBaselineWindows) {
        const base = median(spendBase);
        if (r.spendEurPerDay >= base * R.spendSpikeRatio && r.spendEurPerDay - base >= R.minSpendSpikeEurPerDay) anomalies.push({ code: "SPEND_SPIKE", detail: `Spend/day ${r.spendEurPerDay} EUR vs baseline median ${round(base, 2)} EUR.` });
      }
      if (r.ctr !== null && (latest.impressions ?? 0) >= R.minImpressionsForCtr && ctrBase.length >= R.minBaselineWindows) {
        const base = median(ctrBase);
        if (base > 0 && r.ctr <= base * R.ctrDropRatio) anomalies.push({ code: "CTR_DROP", detail: `CTR ${r.ctr} vs baseline median ${round(base, 6)}.` });
      }
      if (r.cpcEur !== null && (latest.clicks ?? 0) >= R.minClicksForCpc && cpcBase.length >= R.minBaselineWindows) {
        const base = median(cpcBase);
        if (base > 0 && r.cpcEur >= base * R.cpcSpikeRatio) anomalies.push({ code: "CPC_SPIKE", detail: `CPC ${r.cpcEur} EUR vs baseline median ${round(base, 4)} EUR.` });
      }
    }
  }
  const recommendations: { code: AdsRecommendationCode; reason: string }[] = [];
  const dataQuality = anomalies.some((a) => ["CLICKS_EXCEED_IMPRESSIONS", "SPEND_WITHOUT_DELIVERY", "DELIVERY_WITHOUT_SPEND"].includes(a.code)) || (context.untrustedWindows ?? 0) > 0;
  if (dataQuality) recommendations.push({ code: "REVIEW_DATA_QUALITY", reason: "Inconsistent or untrusted provider evidence must be reviewed before acting on performance." });
  if (anomalies.some((a) => a.code === "SPEND_SPIKE")) recommendations.push({ code: "INVESTIGATE_SPEND_SPIKE", reason: "Daily spend rose sharply against this campaign's own history; confirm budget settings in the provider UI." });
  if (anomalies.some((a) => a.code === "CTR_DROP")) recommendations.push({ code: "REVIEW_CREATIVE_AND_TARGETING", reason: "Click-through rate fell well below this campaign's history; review creative fatigue and audience fit." });
  if (anomalies.some((a) => a.code === "CPC_SPIKE")) recommendations.push({ code: "REVIEW_BID_AND_COMPETITION", reason: "Cost per click rose sharply; review bidding strategy and auction competition." });
  if (!latest || baseline.length < R.minBaselineWindows || latest.rates.gaps.some((g) => g.endsWith("_UNKNOWN"))) {
    recommendations.push({ code: "COLLECT_MORE_EVIDENCE", reason: `Trend and anomaly rules need ${R.minBaselineWindows + 1} complete, non-overlapping windows; missing values are not assumed to be zero.` });
  }
  if (!recommendations.length) recommendations.push({ code: "CONTINUE_MONITORING", reason: "No rule fired against this campaign's own history." });

  return {
    provider, campaignId, currency: "EUR" as const, source: "EXISTING_ANALYTICS_SNAPSHOTS" as const,
    status: latest ? "ANALYSED" as const : "NOT_COLLECTED" as const,
    windows: analysed,
    trend: latest && previous ? {
      latestPeriod: latest.period, previousPeriod: previous.period, basis: "PER_DAY" as const,
      spendPerDayChange: change(latest.rates.spendEurPerDay, previous.rates.spendEurPerDay),
      impressionsPerDayChange: change(latest.impressions === null ? null : latest.impressions / latest.rates.days, previous.impressions === null ? null : previous.impressions / previous.rates.days),
      clicksPerDayChange: change(latest.clicks === null ? null : latest.clicks / latest.rates.days, previous.clicks === null ? null : previous.clicks / previous.rates.days),
      ctrChange: change(latest.rates.ctr, previous.rates.ctr),
      cpcChange: change(latest.rates.cpcEur, previous.rates.cpcEur),
      cpmChange: change(latest.rates.cpmEur, previous.rates.cpmEur),
    } : null,
    anomalies, recommendations,
    dataQuality: { untrustedWindows: context.untrustedWindows ?? 0, overlappingWindowsExcluded: overlapping },
    // Hard guarantees: advisory only; no marketplace attribution or ROAS is derived here.
    marketplaceAttributionVerified: false as const, marketplaceRoas: null, organicMetricsIncluded: false as const,
    eligibleForAutomaticAction: false as const, budgetChangeEur: null, spendAuthorized: false as const,
  };
}

/**
 * Loads every stored window for one paid campaign and keeps only windows that pass the canonical
 * ADS-006C readout trust rules (each window is validated on its own; an untrusted window is
 * counted, never silently used). Parameterized and bounded; paid namespace only.
 */
export async function readPaidCampaignIntelligence(db: DbClient, provider: AdsMetricsProvider, campaignId: string) {
  if (!/^[0-9]{5,25}$/.test(campaignId)) throw new Error("Invalid provider campaign identifier");
  const rows = await db.all(sql`
    SELECT m.run_id AS "runId", a.status AS "runStatus",
      a.source_type AS "runSourceType", a.source_reference AS "runSourceReference",
      m.scope_type AS "scopeType", m.scope_id AS "scopeId",
      m.metric_namespace AS "metricNamespace", m.metric_key AS "metricKey",
      m.numeric_value AS "numericValue", m.value_state AS "valueState",
      m.unit AS "unit", m.source_type AS "sourceType",
      m.source_reference AS "sourceReference", m.observed_at AS "observedAt",
      m.collected_at AS "collectedAt", m.metadata_json AS "metadataJson"
    FROM analytics_metric_snapshots m
    LEFT JOIN analytics_runs a ON a.id = m.run_id
    WHERE m.scope_type = 'external_ad_campaign'
      AND m.scope_id = ${`paid_${provider}:${campaignId}`} AND m.metric_namespace = ${`paid_${provider}`}
    ORDER BY m.observed_at DESC, m.collected_at DESC
    LIMIT 500
  `) as PaidSnapshotRow[];
  const groups = new Map<string, PaidSnapshotRow[]>();
  for (const row of rows) groups.set(`${row.runId}|${row.observedAt}`, [...(groups.get(`${row.runId}|${row.observedAt}`) ?? []), row]);
  const byAccount = new Map<string, PaidWindowMetrics[]>();
  let untrustedWindows = 0;
  for (const group of groups.values()) {
    const readout = buildPaidCampaignReadout(provider, campaignId, group);
    const accountId = storedAccountId(group);
    // A window without exactly one verified stored ad-account identity cannot join any history.
    if (readout.status !== "REPORT_AVAILABLE" || !readout.evidence || !("period" in readout) || !readout.period || !accountId) { untrustedWindows += 1; continue; }
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), {
      period: readout.period, sourceReference: readout.sourceReference,
      spendEur: readout.evidence.spendEur, impressions: readout.evidence.impressions, clicks: readout.evidence.clicks,
      providerReportedConversions: readout.evidence.providerReportedConversions,
      providerReportedConversionValueEur: readout.evidence.providerReportedConversionValueEur,
    }]);
  }
  if (byAccount.size > 1) {
    // Never blend ad accounts into one campaign history: quarantine instead of analysing.
    const empty = analyzePaidCampaignWindows(provider, campaignId, [], { untrustedWindows });
    return {
      ...empty, status: "ACCOUNT_CONFLICT" as const, accountId: null,
      accountConflict: [...byAccount].map(([id, ws]) => ({ accountId: id, windows: ws.length })).sort((a, b) => a.accountId.localeCompare(b.accountId)),
      recommendations: [{ code: "REVIEW_DATA_QUALITY" as AdsRecommendationCode, reason: "Stored windows for this campaign come from different ad accounts; no trend, anomaly or recommendation is computed until provenance is resolved." }],
    };
  }
  const [only] = [...byAccount];
  return { ...analyzePaidCampaignWindows(provider, campaignId, only?.[1] ?? [], { untrustedWindows }), accountId: only?.[0] ?? null, accountConflict: [] as { accountId: string; windows: number }[] };
}

/** Exactly one digit-only account id shared by every row of a window, else null. */
function storedAccountId(group: readonly PaidSnapshotRow[]): string | null {
  const ids = new Set(group.map((row) => {
    try { const m: unknown = JSON.parse(row.metadataJson ?? "null"); return m && typeof m === "object" ? (m as { accountId?: unknown }).accountId : undefined; } catch { return undefined; }
  }));
  const [id] = [...ids];
  return ids.size === 1 && typeof id === "string" && /^[0-9]{5,25}$/.test(id) ? id : null;
}
