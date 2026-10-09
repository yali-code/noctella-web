import { describe, expect, it } from "vitest";
import { buildAdsCampaignBriefs } from "../src/use-cases/ads/adsCampaignBriefs";
import { evaluateAdsBudgetProposal } from "../src/use-cases/ads/adsBudgetGuard";
import type { CampaignCandidateProjection } from "../src/use-cases/ads/marketplaceCampaignCandidates";

const eligible: CampaignCandidateProjection = {
  candidates: [{productId:"NOC-000007", title:"Vintage film camera", category:"Cameras", tagKeys:["film-camera"], destination:"ebay", marketplaceUrl:"https://www.ebay.com/itm/123456", decision:"ELIGIBLE_FOR_REVIEW"}],
  exclusions:[], requiresOwnerApproval:true, spendAuthorized:false,
};
describe("ADS-004C review-only plan composition invariants", () => {
  it("keeps creative and money separate from real launch authorization", () => {
    const briefs=buildAdsCampaignBriefs(eligible);
    const budget=evaluateAdsBudgetProposal("NOC-000007",eligible,null,{requestedDailyEur:2,hardDailyLimitEur:5,hardTotalLimitEur:20});
    expect(briefs).toHaveLength(1);
    expect(budget.decision).toBe("BLOCKED");
    expect(budget.blockers).toContain("NO_FINANCIAL_EVIDENCE");
    expect(budget.spendAuthorized).toBe(false);
  });
  it("keeps excluded stock out of creative drafts and budget requests", () => {
    const empty={...eligible,candidates:[]};
    expect(buildAdsCampaignBriefs(empty)).toEqual([]);
    expect(evaluateAdsBudgetProposal("NOC-000007",empty,null,{requestedDailyEur:2,hardDailyLimitEur:5,hardTotalLimitEur:20}).proposedDailyEur).toBeNull();
  });
});
