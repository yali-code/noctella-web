/**
 * ADS-AB1: comparison of two complete, same-scope Meta AD-level observations.
 * This is a TRAFFIC DIAGNOSTIC, not a causal A/B result or marketplace ROAS.
 * No provider requests, database access or ad mutations occur here.
 */
export interface MetaAdTrafficObservation {
  readonly adId: string;
  readonly accountId: string;
  readonly campaignId: string;
  readonly reportingTimeZone: string;
  readonly currency: "EUR";
  readonly sourceReference: "meta.ads.graph_v26_ad_insights";
  readonly window: { readonly start: string; readonly end: string };
  /** Meta's all-clicks metric, not destination/link clicks. */
  readonly clicks: number | null;
  readonly impressions: number | null;
  readonly spendEur: number | null;
}

export type AbTrafficVerdict =
  | "DATA_QUALITY_REVIEW"
  | "INSUFFICIENT_EVIDENCE"
  | "NO_CLEAR_TRAFFIC_DIFFERENCE"
  | "DIRECTIONAL_TRAFFIC_LEAD";

const MIN_IMPRESSIONS_PER_AD = 1000;
const MIN_CLICKS_PER_AD = 30;
const TWO_SIDED_Z_THRESHOLD = 1.96;
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const digits = (id: string) => /^[0-9]{5,25}$/.test(id);

function validCount(v: number | null): boolean {
  return v === null || Number.isSafeInteger(v) && v >= 0;
}
function validMoney(v: number | null): boolean {
  return v === null || Number.isFinite(v) && v >= 0
    && Math.abs(v * 100 - Math.round(v * 100)) < 0.00001;
}
function validObservation(o: MetaAdTrafficObservation): boolean {
  return validCount(o.impressions) && validCount(o.clicks) && validMoney(o.spendEur)
    && (o.impressions === null || o.clicks === null || o.clicks <= o.impressions);
}
function derived(o: MetaAdTrafficObservation, valid: boolean) {
  return {
    adId: o.adId, spendEur: o.spendEur,
    impressions: o.impressions, clicks: o.clicks,
    ctr: valid && o.clicks !== null && o.impressions ? round(o.clicks / o.impressions, 6) : null,
    cpcEur: valid && o.spendEur !== null && o.clicks ? round(o.spendEur / o.clicks, 4) : null,
    cpmEur: valid && o.spendEur !== null && o.impressions ? round(o.spendEur * 1000 / o.impressions, 4) : null,
  };
}

export function compareMetaAdTraffic(a: MetaAdTrafficObservation, b: MetaAdTrafficObservation) {
  if (!digits(a.adId) || !digits(b.adId) || a.adId === b.adId
    || !digits(a.accountId) || !digits(a.campaignId)
    || a.accountId !== b.accountId || a.campaignId !== b.campaignId
    || a.reportingTimeZone !== b.reportingTimeZone || !a.reportingTimeZone
    || a.currency !== "EUR" || b.currency !== "EUR"
    || a.sourceReference !== "meta.ads.graph_v26_ad_insights"
    || b.sourceReference !== a.sourceReference
    || a.window.start !== b.window.start || a.window.end !== b.window.end
    || !Number.isFinite(Date.parse(a.window.start)) || !Number.isFinite(Date.parse(a.window.end))
    || Date.parse(a.window.start) >= Date.parse(a.window.end)) {
    throw new Error("ADS-AB1: ad comparison provenance or reporting window mismatch");
  }

  const validA = validObservation(a), validB = validObservation(b);
  // Preserve raw evidence, but never calculate ratios for an invalid observation.
  const metrics = [derived(a, validA), derived(b, validB)] as const;
  const reasons: string[] = [];
  let verdict: AbTrafficVerdict = "INSUFFICIENT_EVIDENCE";
  let directionalLeaderAdId: string | null = null;
  let absoluteCtrZScore: number | null = null;

  if (!validA || !validB) {
    verdict = "DATA_QUALITY_REVIEW";
    reasons.push("INVALID_META_NUMERIC_EVIDENCE");
  } else if ([a, b].some(o => o.impressions === null || o.clicks === null || o.spendEur === null)) {
    reasons.push("MISSING_METRICS_NOT_ZERO");
  } else if ([a, b].some(o => o.impressions! < MIN_IMPRESSIONS_PER_AD
    || o.clicks! < MIN_CLICKS_PER_AD || o.spendEur! <= 0)) {
    reasons.push("INSUFFICIENT_PER_AD_TRAFFIC_SAMPLE");
  } else {
    const ctrA = a.clicks! / a.impressions!;
    const ctrB = b.clicks! / b.impressions!;
    const pooled = (a.clicks! + b.clicks!) / (a.impressions! + b.impressions!);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.impressions! + 1 / b.impressions!));
    absoluteCtrZScore = se > 0 ? round(Math.abs(ctrA - ctrB) / se, 4) : null;

    // Statistical signal alone cannot prove random allocation or an Etsy order.
    const cheaperCpcA = a.spendEur! / a.clicks! <= b.spendEur! / b.clicks!;
    const cheaperCpcB = b.spendEur! / b.clicks! <= a.spendEur! / a.clicks!;
    if (absoluteCtrZScore !== null && absoluteCtrZScore >= TWO_SIDED_Z_THRESHOLD
      && ((ctrA > ctrB && cheaperCpcA) || (ctrB > ctrA && cheaperCpcB))) {
      verdict = "DIRECTIONAL_TRAFFIC_LEAD";
      directionalLeaderAdId = ctrA > ctrB ? a.adId : b.adId;
      reasons.push("CTR_DIFFERENCE_AND_CPC_DIRECTION_AGREE");
    } else {
      verdict = "NO_CLEAR_TRAFFIC_DIFFERENCE";
      reasons.push("NO_CONSISTENT_95_PERCENT_TRAFFIC_SIGNAL");
    }
  }

  // Even randomized delivery and a significant all-click signal cannot establish
  // better marketplace conversion or sales without attributable order evidence.
  return {
    mode: "META_AD_AB_TRAFFIC_DIAGNOSTIC" as const,
    provider: "meta" as const,
    accountId: a.accountId,
    campaignId: a.campaignId,
    currency: "EUR" as const,
    reportingTimeZone: a.reportingTimeZone,
    window: a.window,
    clickDefinition: "META_ALL_CLICKS" as const,
    metrics, verdict, directionalLeaderAdId, absoluteCtrZScore, reasons,
    comparisonIsRandomizedExperimentVerified: false as const,
    causalAbWinnerVerified: false as const,
    marketplaceAttributionVerified: false as const,
    marketplaceRoas: null,
    campaignModified: false as const,
    spendAuthorized: false as const,
  };
}
