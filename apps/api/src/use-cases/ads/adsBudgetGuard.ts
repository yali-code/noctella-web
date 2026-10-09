import type { CatalogueProfitabilityItem } from "../analytics/catalogueProfitability";
import type { CampaignCandidateProjection } from "./marketplaceCampaignCandidates";

/**
 * ADS-004B: read-only financial decision evidence; NOT an authorization to spend.
 * No invented profit for unsold items, no predictive ROAS, no external billing.
 */
export type AdsBudgetDecision = "BLOCKED" | "NEEDS_HUMAN_REVIEW";
export type AdsBudgetBlocker =
  | "NO_ELIGIBLE_LISTING" | "NO_FINANCIAL_EVIDENCE" | "UNVERIFIED_COST"
  | "INVALID_BUDGET" | "OVER_HARD_CAP" | "NON_POSITIVE_ECONOMICS";
export interface AdsBudgetProposal {
  readonly productId: string;
  readonly currency: "EUR";
  readonly proposedDailyEur: number | null;
  readonly hardDailyLimitEur: number;
  readonly hardTotalLimitEur: number;
  readonly decision: AdsBudgetDecision;
  readonly blockers: readonly AdsBudgetBlocker[];
  readonly evidence: {
    readonly landedCostEur: number | null;
    readonly historicalProfitEur: number | null;
    readonly profitStatus: CatalogueProfitabilityItem["profitStatus"] | "UNKNOWN";
  };
  readonly requiresOwnerApproval: true;
  readonly spendAuthorized: false;
}
export interface AdsBudgetPolicy {
  readonly requestedDailyEur: number;
  readonly hardDailyLimitEur: number;
  readonly hardTotalLimitEur: number;
}
const validAmount = (x: number) => Number.isFinite(x) && x > 0 && x <= 1_000_000 && Math.round(x * 100) === x * 100;
export function evaluateAdsBudgetProposal(
  productId: string,
  projection: CampaignCandidateProjection,
  financial: Pick<CatalogueProfitabilityItem, "productId" | "authoritativeLandedCost" | "profitStatus" | "latestSale"> | null,
  policy: AdsBudgetPolicy,
): AdsBudgetProposal {
  const blockers: AdsBudgetBlocker[] = [];
  const eligible = projection.requiresOwnerApproval === true && projection.spendAuthorized === false
    && projection.candidates.some(c => c.productId === productId && c.decision === "ELIGIBLE_FOR_REVIEW");
  if (!eligible) blockers.push("NO_ELIGIBLE_LISTING");
  const valid = [policy.requestedDailyEur, policy.hardDailyLimitEur, policy.hardTotalLimitEur].every(validAmount);
  if (!valid) blockers.push("INVALID_BUDGET");
  else if (policy.requestedDailyEur > policy.hardDailyLimitEur
    || policy.requestedDailyEur > policy.hardTotalLimitEur
    || policy.hardDailyLimitEur > policy.hardTotalLimitEur) blockers.push("OVER_HARD_CAP");
  const matches = financial?.productId === productId;
  const landed = matches && financial?.authoritativeLandedCost != null && Number.isFinite(financial.authoritativeLandedCost)
    ? financial.authoritativeLandedCost : null;
  const profit = matches && financial?.profitStatus === "COMPLETE"
    ? financial.latestSale?.knownProfit ?? null : null;
  if (!matches) blockers.push("NO_FINANCIAL_EVIDENCE");
  else if (landed === null || landed < 0 || financial?.profitStatus !== "COMPLETE" || profit === null || !Number.isFinite(profit))
    blockers.push("UNVERIFIED_COST");
  else if (profit <= 0) blockers.push("NON_POSITIVE_ECONOMICS");
  return {
    productId, currency: "EUR",
    proposedDailyEur: blockers.length === 0 ? policy.requestedDailyEur : null,
    hardDailyLimitEur: validAmount(policy.hardDailyLimitEur) ? policy.hardDailyLimitEur : 0,
    hardTotalLimitEur: validAmount(policy.hardTotalLimitEur) ? policy.hardTotalLimitEur : 0,
    decision: blockers.length === 0 ? "NEEDS_HUMAN_REVIEW" : "BLOCKED",
    blockers,
    evidence: { landedCostEur: landed, historicalProfitEur: profit, profitStatus: matches ? financial!.profitStatus : "UNKNOWN" },
    requiresOwnerApproval: true, spendAuthorized: false,
  };
}
