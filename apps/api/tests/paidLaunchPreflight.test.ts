import { describe, expect, it } from "vitest";
import { evaluatePaidLaunchPreflight, type PaidLaunchPreflightFacts } from "../src/use-cases/ads/paidLaunchPreflight";

const candidate: PaidLaunchPreflightFacts = {
  provider:"meta", productId:"NOC-000007",
  brief:{productId:"NOC-000007",destination:"ebay",marketplaceUrl:"https://www.ebay.com/itm/123456",title:"Camera",category:"Cameras",keywordHints:[],objective:"MARKETPLACE_TRAFFIC",creativeBrief:{hook:"Camera",proofRequired:[],callToAction:"View the original listing"},humanReviewRequired:true,status:"DRAFT"},
  budget:{productId:"NOC-000007",currency:"EUR",proposedDailyEur:2,hardDailyLimitEur:5,hardTotalLimitEur:20,decision:"NEEDS_HUMAN_REVIEW",blockers:[],evidence:{landedCostEur:40,historicalProfitEur:20,profitStatus:"COMPLETE"},requiresOwnerApproval:true,spendAuthorized:false},
  ownerApproval:{productId:"NOC-000007",marketplaceUrl:"https://www.ebay.com/itm/123456",maxDailyEur:5,maxTotalEur:20,approvedByOwner:true},
  providerAccountVerified:true,liveListingRevalidated:true,automaticPauseReady:true,globalBudgetEnforcementReady:true,privacyAndPolicyApproved:true,
};
describe("ADS-005B paid provider preflight always remains dry-run", () => {
  it("cannot launch or authorize spend even when all hypothetical checks pass", () => {
    const r=evaluatePaidLaunchPreflight(candidate);
    expect(r.blockers).toEqual([]);
    expect(r.safetyRequirementsSatisfied).toBe(true);
    expect(r.mode).toBe("DRY_RUN_ONLY");
    expect(r.launchExecuted).toBe(false);
    expect(r.spendAuthorized).toBe(false);
  });
  it("fails closed with every absent operational permission", () => {
    const r=evaluatePaidLaunchPreflight({...candidate,ownerApproval:null,providerAccountVerified:false,liveListingRevalidated:false,automaticPauseReady:false,globalBudgetEnforcementReady:false,privacyAndPolicyApproved:false});
    expect(r.blockers).toEqual(["NO_OWNER_APPROVAL","NO_VERIFIED_PROVIDER","NO_FRESH_LIVE_LISTING","NO_AUTOMATIC_PAUSE","NO_SPEND_ENFORCEMENT","NO_PRIVACY_APPROVAL"]);
  });
  it("requires approval bound to this product, exact target and caps", () => {
    expect(evaluatePaidLaunchPreflight({...candidate,ownerApproval:{...candidate.ownerApproval!,marketplaceUrl:"https://www.ebay.com/itm/987654"}}).blockers).toContain("INVALID_APPROVAL_BINDING");
    expect(evaluatePaidLaunchPreflight({...candidate,ownerApproval:{...candidate.ownerApproval!,maxTotalEur:1000}}).blockers).toContain("INVALID_APPROVAL_BINDING");
  });
  it("blocks review-unsupported budgets and invalid candidate data", () => {
    expect(evaluatePaidLaunchPreflight({...candidate,budget:{...candidate.budget,decision:"BLOCKED",blockers:["UNVERIFIED_COST"]}}).blockers).toContain("BUDGET_NOT_REVIEWABLE");
    expect(evaluatePaidLaunchPreflight({...candidate,brief:null}).blockers).toContain("INVALID_CAMPAIGN_BRIEF");
  });
});
