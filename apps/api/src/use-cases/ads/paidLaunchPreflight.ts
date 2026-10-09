import type { AdsBudgetProposal } from "./adsBudgetGuard";
import type { AdsCampaignBrief } from "./adsCampaignBriefs";

/**
 * ADS-005B: pure campaign launch PRE-FLIGHT, not a launcher. No HTTP, provider
 * SDK, credentials, database writes, account mutations, or billing side effects.
 */
export type PaidProvider = "meta" | "google_ads" | "pinterest_ads";
export type PaidLaunchBlocker =
  | "NO_OWNER_APPROVAL" | "NO_VERIFIED_PROVIDER" | "NO_FRESH_LIVE_LISTING"
  | "NO_AUTOMATIC_PAUSE" | "NO_SPEND_ENFORCEMENT" | "NO_PRIVACY_APPROVAL"
  | "INVALID_CAMPAIGN_BRIEF" | "BUDGET_NOT_REVIEWABLE" | "INVALID_APPROVAL_BINDING";
export interface PaidLaunchPreflightFacts {
  readonly provider: PaidProvider;
  readonly productId: string;
  readonly brief: AdsCampaignBrief | null;
  readonly budget: AdsBudgetProposal;
  /** A separately authorized owner approval bound to these exact inputs. */
  readonly ownerApproval: {
    readonly productId: string;
    readonly marketplaceUrl: string;
    readonly maxDailyEur: number;
    readonly maxTotalEur: number;
    readonly approvedByOwner: boolean;
  } | null;
  readonly providerAccountVerified: boolean;
  readonly liveListingRevalidated: boolean;
  readonly automaticPauseReady: boolean;
  readonly globalBudgetEnforcementReady: boolean;
  readonly privacyAndPolicyApproved: boolean;
}
export interface PaidLaunchPreflightResult {
  readonly provider: PaidProvider;
  readonly productId: string;
  readonly blockers: readonly PaidLaunchBlocker[];
  readonly safetyRequirementsSatisfied: boolean;
  /** PR is intentionally preflight-only; success never executes or authorizes spend. */
  readonly mode: "DRY_RUN_ONLY";
  readonly launchExecuted: false;
  readonly spendAuthorized: false;
}
function isPositiveEurCents(value: number): boolean {
  return Number.isSafeInteger(Math.round(value * 100))
    && Number.isFinite(value) && value > 0
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}
export function evaluatePaidLaunchPreflight(input: PaidLaunchPreflightFacts): PaidLaunchPreflightResult {
  const blockers: PaidLaunchBlocker[] = [];
  const brief = input.brief;
  const budget = input.budget;
  const approval = input.ownerApproval;
  if (!brief || brief.status !== "DRAFT" || brief.humanReviewRequired !== true
    || brief.productId !== input.productId || !/^https:\/\//.test(brief.marketplaceUrl)
    || !["ebay", "etsy"].includes(brief.destination)) blockers.push("INVALID_CAMPAIGN_BRIEF");
  if (budget.productId !== input.productId || budget.decision !== "NEEDS_HUMAN_REVIEW"
    || budget.blockers.length !== 0 || budget.spendAuthorized !== false
    || budget.proposedDailyEur === null || !isPositiveEurCents(budget.proposedDailyEur)
    || !isPositiveEurCents(budget.hardDailyLimitEur)
    || !isPositiveEurCents(budget.hardTotalLimitEur)) blockers.push("BUDGET_NOT_REVIEWABLE");
  if (!approval?.approvedByOwner) blockers.push("NO_OWNER_APPROVAL");
  if (approval && (!brief || approval.productId !== input.productId
    || approval.marketplaceUrl !== brief.marketplaceUrl
    || !isPositiveEurCents(approval.maxDailyEur)
    || !isPositiveEurCents(approval.maxTotalEur)
    || approval.maxDailyEur > budget.hardDailyLimitEur
    || approval.maxTotalEur > budget.hardTotalLimitEur
    || budget.proposedDailyEur === null
    || approval.maxDailyEur < budget.proposedDailyEur)) blockers.push("INVALID_APPROVAL_BINDING");
  if (!input.providerAccountVerified) blockers.push("NO_VERIFIED_PROVIDER");
  if (!input.liveListingRevalidated) blockers.push("NO_FRESH_LIVE_LISTING");
  if (!input.automaticPauseReady) blockers.push("NO_AUTOMATIC_PAUSE");
  if (!input.globalBudgetEnforcementReady) blockers.push("NO_SPEND_ENFORCEMENT");
  if (!input.privacyAndPolicyApproved) blockers.push("NO_PRIVACY_APPROVAL");
  return {
    provider: input.provider, productId: input.productId,
    blockers, safetyRequirementsSatisfied: blockers.length === 0,
    mode: "DRY_RUN_ONLY", launchExecuted: false, spendAuthorized: false,
  };
}
