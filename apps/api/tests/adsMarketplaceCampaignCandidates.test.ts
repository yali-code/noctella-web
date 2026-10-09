import { describe, expect, it } from "vitest";
import { projectMarketplaceCampaignCandidates, type CampaignProductFacts } from "../src/use-cases/ads/marketplaceCampaignCandidates";

const product: CampaignProductFacts = {
  productId: "NOC-000007", title: "Vintage Camera", category: "Cameras",
  marketingTagKeys: ["film-cameras", "vintage-cameras", "film-cameras"],
  product: { status: "published", salePausedAt: null, availableQuantity: 1 },
  listings: [
    { channel: "ebay", externalStatus: "active", externalListingUrl: "https://www.ebay.com/itm/123456", externalListingId: "123456" },
    { channel: "etsy", externalStatus: "active", externalListingUrl: "https://www.etsy.com/listing/789012", externalListingId: "789012" },
  ],
};

describe("ADS-002C.1 read-only marketplace campaign candidates", () => {
  it("reuses ERP marketing tag keys and allows both verified marketplace listings", () => {
    const result = projectMarketplaceCampaignCandidates([product]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((x) => x.destination)).toEqual(["ebay", "etsy"]);
    expect(result.candidates[0]?.tagKeys).toEqual(["film-cameras", "vintage-cameras"]);
    expect(result.exclusions).toEqual([]);
    expect(result.requiresOwnerApproval).toBe(true);
    expect(result.spendAuthorized).toBe(false);
  });
  it("never advertises sold, unpublished, paused or unknown-stock products", () => {
    for (const modified of [
      { ...product.product, status: "sold" },
      { ...product.product, status: "draft" },
      { ...product.product, salePausedAt: "2026-10-09T11:00:00Z" },
      { ...product.product, availableQuantity: null },
      { ...product.product, availableQuantity: 0 },
    ]) {
      const result = projectMarketplaceCampaignCandidates([{ ...product, product: modified }]);
      expect(result.candidates).toEqual([]);
      expect(result.exclusions).toHaveLength(2);
    }
  });
  it("refuses mismatched marketplace IDs and ended listings", () => {
    const result = projectMarketplaceCampaignCandidates([{ ...product, listings: [
      { ...product.listings[0]!, externalListingId: "999999" },
      { ...product.listings[1]!, externalStatus: "ended" },
    ] }]);
    expect(result.candidates).toEqual([]);
    expect(result.exclusions.map(x => x.blocker)).toEqual(["LISTING_ID_MISMATCH", "LISTING_NOT_ACTIVE"]);
  });
  it("fails closed without verified listing or valid product identity", () => {
    expect(projectMarketplaceCampaignCandidates([{ ...product, listings: [] }]).exclusions[0]?.blocker).toBe("NO_LISTING");
    expect(projectMarketplaceCampaignCandidates([{ ...product, productId: "../unsafe" }]).exclusions[0]?.blocker).toBe("INVALID_PRODUCT_ID");
  });
  it("deduplicates repeated records/links without discarding distinct listing identities", () => {
    const result = projectMarketplaceCampaignCandidates([product, product]);
    expect(result.candidates).toHaveLength(2);
  });
  it("filters malformed tags but never invents audience classifications", () => {
    const result = projectMarketplaceCampaignCandidates([{ ...product, marketingTagKeys: ["valid-tag", "Unverified Name", "", "valid-tag"] }]);
    expect(result.candidates[0]?.tagKeys).toEqual(["valid-tag"]);
  });
  it("never sends outbound clicks or assumes conversion evidence", () => {
    const result = projectMarketplaceCampaignCandidates([product]);
    expect(JSON.stringify(result)).not.toContain("purchase");
    expect(JSON.stringify(result)).not.toContain("conversionValue");
    expect(result.spendAuthorized).toBe(false);
  });
});
