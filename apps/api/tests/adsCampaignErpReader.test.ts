import { describe, expect, it } from "vitest";
import { isReviewableMarketplaceEvidence, stockSyncProviderListingIdentity, type AdsListingEvidence } from "../src/use-cases/ads/adsCampaignErpReader";

const now = new Date("2026-10-09T13:00:00.000Z");
const good: AdsListingEvidence = {
  productId: "NOC-000007",
  listingRowId: "ext-123",
  externalUpdatedAt: "2026-10-09T12:00:00.000Z",
  snapshotCapturedAt: "2026-10-09T12:30:00.000Z",
  marketplaceStock: 1,
  openConflictCount: 0,
};

describe("ADS-002C.4 marketplace freshness and conflict evidence", () => {
  it("accepts recent, consistent local evidence only as reviewable", () => {
    expect(isReviewableMarketplaceEvidence(good, now)).toBe(true);
  });
  it("blocks zero/unknown provider inventory and open stock conflicts", () => {
    expect(isReviewableMarketplaceEvidence({ ...good, marketplaceStock: 0 }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, marketplaceStock: null }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, openConflictCount: 1 }, now)).toBe(false);
  });
  it("blocks stale, missing and future timestamps", () => {
    expect(isReviewableMarketplaceEvidence({ ...good, externalUpdatedAt: "2026-10-07T00:00:00Z" }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, snapshotCapturedAt: null }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, snapshotCapturedAt: "2026-10-09T14:00:00Z" }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, externalUpdatedAt: "bad date" }, now)).toBe(false);
  });
  it("requires a valid nonnegative integer conflict count and stock", () => {
    expect(isReviewableMarketplaceEvidence({ ...good, openConflictCount: -1 }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, marketplaceStock: 0.5 }, now)).toBe(false);
    expect(isReviewableMarketplaceEvidence({ ...good, openConflictCount: Number.NaN }, now)).toBe(false);
  });
  it("uses the actual eBay/Etsy provider listing number rather than the internal row ID", () => {
    expect(stockSyncProviderListingIdentity({ channel: "ebay", externalListingId: "123456789012" }))
      .toEqual({ channel: "ebay", providerListingId: "123456789012" });
    expect(stockSyncProviderListingIdentity({ channel: "etsy", externalListingId: "9876543210" }))
      .toEqual({ channel: "etsy", providerListingId: "9876543210" });
  });
  it("rejects internal row IDs, unsupported marketplaces, and invalid provider IDs", () => {
    expect(stockSyncProviderListingIdentity({ channel: "ebay", externalListingId: "ext-internal-uuid" })).toBeNull();
    expect(stockSyncProviderListingIdentity({ channel: "woocommerce", externalListingId: "123456" })).toBeNull();
    expect(stockSyncProviderListingIdentity({ channel: "etsy", externalListingId: "1234" })).toBeNull();
    expect(stockSyncProviderListingIdentity({ channel: "etsy", externalListingId: "123456;DROP" })).toBeNull();
  });

});
