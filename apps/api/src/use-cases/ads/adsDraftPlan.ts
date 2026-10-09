import type { DbClient } from "../../db/client";
import { getProductProfitability } from "../../services/productProfitability";
import { toCatalogueItem } from "../analytics/catalogueProfitability";
import { readAdsCampaignReviewFromErp } from "./adsCampaignErpReader";
import { buildAdsCampaignBriefs } from "./adsCampaignBriefs";
import { evaluateAdsBudgetProposal, type AdsBudgetPolicy } from "./adsBudgetGuard";

/**
 * ADS-004C. All three stages are advisory: verify existing ERP facts,
 * produce grounded drafts, then attach existing Analytics financial evidence.
 * This function has no writes, provider calls, campaign launch, or side effects.
 */
export async function readAdsDraftPlanForProduct(
  db: DbClient, productId: string, policy: AdsBudgetPolicy, now = new Date(),
) {
  const review = await readAdsCampaignReviewFromErp(db, productId, now);
  // Only read profitability after the verified product lookup has completed.
  // Existing Analytics Agent remains the sole financial calculation authority.
  const profitability = toCatalogueItem({
    profitability: getProductProfitability(db, productId, now),
    insights: [],
  });
  const campaignBriefs = buildAdsCampaignBriefs(review.projection);
  const budget = evaluateAdsBudgetProposal(productId, review.projection, profitability, policy);
  return {
    productId,
    generatedAt: now.toISOString(),
    scope: "DRAFT_REVIEW_ONLY" as const,
    inventoryVerification: review.inventoryVerification,
    campaignBriefs,
    exclusions: review.projection.exclusions,
    budget,
    liveProviderVerified: false as const,
    ownerApprovalRecorded: false as const,
    spendAuthorized: false as const,
  };
}
