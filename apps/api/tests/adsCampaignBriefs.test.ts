import { describe, expect, it } from "vitest";
import { buildAdsCampaignBriefs } from "../src/use-cases/ads/adsCampaignBriefs";
import type { CampaignCandidateProjection } from "../src/use-cases/ads/marketplaceCampaignCandidates";
const projection: CampaignCandidateProjection = {
  candidates: [{ productId:"NOC-000007", destination:"ebay", marketplaceUrl:"https://www.ebay.com/itm/123456", title:"Vintage Camera", category:"Cameras", tagKeys:["film-cameras","vintage-cameras"], decision:"ELIGIBLE_FOR_REVIEW" }],
  exclusions:[], spendAuthorized:false, requiresOwnerApproval:true,
};
describe("ADS-004A explainable campaign briefs", () => {
  it("creates reviewed traffic briefs from existing qualified candidates only", () => {
    const briefs = buildAdsCampaignBriefs(projection);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.objective).toBe("MARKETPLACE_TRAFFIC");
    expect(briefs[0]?.keywordHints).toEqual(["film-cameras","vintage-cameras"]);
    expect(briefs[0]?.humanReviewRequired).toBe(true);
    expect(briefs[0]?.status).toBe("DRAFT");
    expect(JSON.stringify(briefs)).not.toContain("Purchase");
  });
  it("deduplicates and applies fixed bounds", () => {
    expect(buildAdsCampaignBriefs({ ...projection, candidates: [projection.candidates[0]!,projection.candidates[0]!] })).toHaveLength(1);
    expect(buildAdsCampaignBriefs(projection,{maxBriefs:0})).toEqual([]);
  });
  it("rejects unsafely approved inputs and malformed product IDs", () => {
    expect(buildAdsCampaignBriefs({ ...projection, spendAuthorized:true } as unknown as CampaignCandidateProjection)).toEqual([]);
    expect(buildAdsCampaignBriefs({ ...projection, candidates:[{ ...projection.candidates[0]!, productId:"../oops" }] })).toEqual([]);
  });
  it("never invents demographics, order values or conversion events", () => {
    const data = JSON.stringify(buildAdsCampaignBriefs(projection));
    expect(data).not.toMatch(/audienceAge|gender|purchaseValue|conversionProbability|roas/i);
  });
});
