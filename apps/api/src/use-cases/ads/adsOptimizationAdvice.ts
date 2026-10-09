import type { AdsPerformanceEvidence } from "./adsPerformanceEvidence";

/**
 * ADS-006B: explainable OPTIMIZATION ADVICE only. Never changes campaigns,
 * spend or stock. Missing measurements produce investigation, not extrapolation.
 */
export type AdsOptimizationRecommendation =
  | "COLLECT_MORE_EVIDENCE"
  | "REVIEW_SPEND_AND_TRAFFIC"
  | "REVIEW_PROVIDER_REPORTED_RETURN"
  | "REVIEW_DATA_QUALITY";
export interface AdsOptimizationAdvice {
  readonly provider: AdsPerformanceEvidence["provider"];
  readonly recommendation: AdsOptimizationRecommendation;
  readonly reasons: readonly string[];
  readonly eligibleForAutomaticAction: false;
  readonly budgetChangeEur: null;
  readonly campaignPauseExecuted: false;
  readonly spendAuthorized: false;
}
export function assessAdsOptimization(
  evidence: AdsPerformanceEvidence,
): AdsOptimizationAdvice {
  const reasons: string[] = [];
  let recommendation: AdsOptimizationRecommendation = "COLLECT_MORE_EVIDENCE";
  if (evidence.warnings.some(w =>
    w.startsWith("INVALID_") || w === "CLICKS_EXCEED_IMPRESSIONS"
    || w === "CONVERSION_VALUE_WITHOUT_COUNT"
  )) {
    recommendation = "REVIEW_DATA_QUALITY";
    reasons.push("Measurement inconsistency must be reviewed before any recommendation.");
  } else if (evidence.evidenceLevel === "INCOMPLETE") {
    reasons.push("Spend and traffic evidence is incomplete; do not assume zero or infer purchases.");
  } else if (evidence.evidenceLevel === "SPEND_AND_TRAFFIC_ONLY") {
    recommendation = "REVIEW_SPEND_AND_TRAFFIC";
    reasons.push("Traffic and spend observations are available; confirmed marketplace conversion attribution is not.");
  } else {
    recommendation = "REVIEW_PROVIDER_REPORTED_RETURN";
    reasons.push("Provider-reported conversion value is not verified marketplace revenue.");
  }
  if (evidence.attributedMarketplaceRevenueEur !== null) {
    // A downstream caller must not silently upgrade attribution confidence.
    recommendation = "REVIEW_DATA_QUALITY";
    reasons.push("Unexpected marketplace-attributed revenue: provenance review required.");
  }
  return {
    provider: evidence.provider,
    recommendation, reasons,
    eligibleForAutomaticAction: false,
    budgetChangeEur: null,
    campaignPauseExecuted: false,
    spendAuthorized: false,
  };
}
