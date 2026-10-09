import type { DbClient } from "../../db/client";
import { readAdsDraftPlanForProduct } from "./adsDraftPlan";
import type { AdsBudgetPolicy } from "./adsBudgetGuard";
import { evaluatePaidLaunchPreflight, type PaidProvider } from "./paidLaunchPreflight";

/**
 * Intentionally does NOT accept readiness booleans from client parameters:
 * without authoritative provider/account/kill-switch evidence they are false.
 * A real paid launch must use a separate owner-authorized workflow later.
 */
export async function readPaidAdsDryRunFromErp(
  db: DbClient, productId: string, provider: PaidProvider,
  budgetPolicy: AdsBudgetPolicy, now = new Date(),
) {
  const plan = await readAdsDraftPlanForProduct(db, productId, budgetPolicy, now);
  const preflight = evaluatePaidLaunchPreflight({
    provider, productId,
    brief: plan.campaignBriefs[0] ?? null,
    budget: plan.budget,
    ownerApproval: null,
    providerAccountVerified: false,
    liveListingRevalidated: false,
    automaticPauseReady: false,
    globalBudgetEnforcementReady: false,
    privacyAndPolicyApproved: false,
  });
  return {
    scope: "DRY_RUN_ONLY" as const,
    productId, provider,
    campaignBriefCount: plan.campaignBriefs.length,
    preflight,
    liveProviderVerified: false as const,
    spendAuthorized: false as const,
  };
}
