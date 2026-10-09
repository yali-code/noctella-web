/**
 * ADS-006A — read-only, provider-specific paid performance evidence.
 * Existing Analytics Agent remains the source of truth for observations.
 * Never turn organic Instagram/Pinterest reach, outbound clicks or inferred
 * marketplace purchases into paid attributed revenue.
 */
export type AdsMetricsProvider = "meta" | "google_ads" | "pinterest_ads";
export type AdsEvidenceLevel = "INCOMPLETE" | "SPEND_AND_TRAFFIC_ONLY" | "PROVIDER_REPORTED_CONVERSIONS";
export interface PaidMetricFacts {
  readonly provider: AdsMetricsProvider;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: "EUR";
  readonly spendEur: number | null;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly providerReportedConversions: number | null;
  /** Only provider-reported, never assumed to be marketplace-confirmed orders. */
  readonly providerReportedConversionValueEur: number | null;
  readonly marketplaceConfirmedOrders: number | null;
}
export interface AdsPerformanceEvidence {
  readonly provider: AdsMetricsProvider;
  readonly evidenceLevel: AdsEvidenceLevel;
  readonly spendEur: number | null;
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly providerReportedConversions: number | null;
  readonly providerReportedConversionValueEur: number | null;
  readonly marketplaceConfirmedOrders: number | null;
  readonly reportedRoas: number | null;
  readonly attributedMarketplaceRevenueEur: null;
  readonly cannotInferMarketplacePurchasesFromClicks: true;
  readonly warnings: readonly string[];
}
function nonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}
export function evaluateAdsPerformanceEvidence(facts: PaidMetricFacts): AdsPerformanceEvidence {
  const warnings: string[] = [];
  const periodStart = Date.parse(facts.periodStart), periodEnd = Date.parse(facts.periodEnd);
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd <= periodStart) warnings.push("INVALID_PERIOD");
  for (const [key, value] of [
    ["spend", facts.spendEur], ["impressions", facts.impressions], ["clicks", facts.clicks],
    ["conversions", facts.providerReportedConversions], ["conversion_value", facts.providerReportedConversionValueEur],
    ["marketplace_orders", facts.marketplaceConfirmedOrders],
  ] as const) {
    if (value !== null && !nonnegative(value)) warnings.push(`INVALID_${key.toUpperCase()}`);
  }
  const spendEur = nonnegative(facts.spendEur) ? facts.spendEur : null;
  const impressions = nonnegative(facts.impressions) && Number.isSafeInteger(facts.impressions) ? facts.impressions : null;
  const clicks = nonnegative(facts.clicks) && Number.isSafeInteger(facts.clicks) ? facts.clicks : null;
  const conversions = nonnegative(facts.providerReportedConversions) && Number.isSafeInteger(facts.providerReportedConversions)
    ? facts.providerReportedConversions : null;
  const value = nonnegative(facts.providerReportedConversionValueEur) ? facts.providerReportedConversionValueEur : null;
  const orders = nonnegative(facts.marketplaceConfirmedOrders) && Number.isSafeInteger(facts.marketplaceConfirmedOrders)
    ? facts.marketplaceConfirmedOrders : null;
  if (clicks !== null && impressions !== null && clicks > impressions) warnings.push("CLICKS_EXCEED_IMPRESSIONS");
  if (orders !== null) warnings.push("ORDERS_NOT_AD_ATTRIBUTED");
  if (conversions !== null) warnings.push("PROVIDER_CONVERSIONS_NOT_MARKETPLACE_CONFIRMED");
  if (value !== null && conversions === null) warnings.push("CONVERSION_VALUE_WITHOUT_COUNT");
  if (spendEur === 0 && value !== null) warnings.push("ROAS_UNDEFINED_ZERO_SPEND");
  const valid = !warnings.some(x => x.startsWith("INVALID_") || x === "CLICKS_EXCEED_IMPRESSIONS" || x === "CONVERSION_VALUE_WITHOUT_COUNT");
  const reportedRoas = valid && spendEur !== null && spendEur > 0 && value !== null && conversions !== null
    ? Math.round((value / spendEur) * 1000) / 1000 : null;
  const evidenceLevel: AdsEvidenceLevel = !valid || spendEur === null || impressions === null || clicks === null
    ? "INCOMPLETE"
    : conversions !== null && value !== null ? "PROVIDER_REPORTED_CONVERSIONS" : "SPEND_AND_TRAFFIC_ONLY";
  return {
    provider: facts.provider, evidenceLevel, spendEur, impressions, clicks,
    providerReportedConversions: conversions, providerReportedConversionValueEur: value,
    marketplaceConfirmedOrders: orders, reportedRoas,
    attributedMarketplaceRevenueEur: null,
    cannotInferMarketplacePurchasesFromClicks: true, warnings,
  };
}
