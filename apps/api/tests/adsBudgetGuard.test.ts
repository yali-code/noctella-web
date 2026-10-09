import { describe, expect, it } from "vitest";
import { evaluateAdsBudgetProposal } from "../src/use-cases/ads/adsBudgetGuard";
import type { CampaignCandidateProjection } from "../src/use-cases/ads/marketplaceCampaignCandidates";
import type { CatalogueProfitabilityItem } from "../src/use-cases/analytics/catalogueProfitability";
const projection: CampaignCandidateProjection = { candidates: [{ productId:"NOC-000007", title:"Camera", category:"Cameras", tagKeys:[], destination:"ebay", marketplaceUrl:"https://www.ebay.com/itm/123456", decision:"ELIGIBLE_FOR_REVIEW" }], exclusions:[], requiresOwnerApproval:true, spendAuthorized:false };
const finance = { productId:"NOC-000007", authoritativeLandedCost:40, profitStatus:"COMPLETE" as const, latestSale:{ orderId:"order1",completedAt:"2026-10-09",knownProfit:50,profitBeforeUnknownCosts:50,marginPercent:30,roiPercent:60 } };
const policy = { requestedDailyEur:2, hardDailyLimitEur:5, hardTotalLimitEur:15 };
const evaluate = (p=projection, f: Pick<CatalogueProfitabilityItem,"productId"|"authoritativeLandedCost"|"profitStatus"|"latestSale"> | null = finance, b=policy) => evaluateAdsBudgetProposal("NOC-000007",p,f,b);
describe("ADS-004B budget and finance approval guard", () => {
  it("never allows spending, even when evidence and caps pass", () => {
    const r=evaluate();
    expect(r.decision).toBe("NEEDS_HUMAN_REVIEW");
    expect(r.spendAuthorized).toBe(false);
    expect(r.requiresOwnerApproval).toBe(true);
    expect(r.proposedDailyEur).toBe(2);
  });
  it("blocks insufficient cost/profit evidence rather than fabricating ROAS", () => {
    expect(evaluate(projection,null).blockers).toContain("NO_FINANCIAL_EVIDENCE");
    expect(evaluate(projection,{ ...finance, profitStatus:"NOT_SOLD", latestSale:null }).blockers).toContain("UNVERIFIED_COST");
    expect(evaluate(projection,{ ...finance, authoritativeLandedCost:null }).blockers).toContain("UNVERIFIED_COST");
    expect(JSON.stringify(evaluate())).not.toMatch(/forecastRoas|predictedConversion|purchaseValue/i);
  });
  it("blocks missing eligible listing or invalid authorization state", () => {
    expect(evaluate({ ...projection, candidates:[] }).blockers).toContain("NO_ELIGIBLE_LISTING");
    expect(evaluate({ ...projection, spendAuthorized:true } as unknown as CampaignCandidateProjection).decision).toBe("BLOCKED");
  });
  it("blocks overspending, invalid fractional cents and negative daily caps", () => {
    expect(evaluate(projection, finance, { ...policy, requestedDailyEur:10 }).blockers).toContain("OVER_HARD_CAP");
    expect(evaluate(projection, finance, { ...policy, requestedDailyEur:1.001 }).blockers).toContain("INVALID_BUDGET");
    expect(evaluate(projection, finance, { ...policy, hardTotalLimitEur:-1 }).proposedDailyEur).toBeNull();
  });
  it("blocks nonpositive historical profit", () => {
    expect(evaluate(projection, { ...finance, latestSale: { ...finance.latestSale, knownProfit:-2 } }).blockers).toContain("NON_POSITIVE_ECONOMICS");
  });
});
