import { describe, expect, it, vi } from "vitest";
import { readMarketplaceCampaignCandidatesForProduct, verifiedAvailableQuantity, type TrustedMarketplaceCampaignReaders } from "../src/use-cases/ads/marketplaceCampaignRead";
import type { ProductAvailabilityProjection } from "../src/repositories/product-read/types";

const availability: ProductAvailabilityProjection = { productId: "NOC-000007", physicalStock: 2, reservedStock: 1, reservedStockSupported: true, availableStock: 1, availableQuantity: 1 };
const listing = { channel: "ebay", externalStatus: "active", externalListingId: "123456", externalListingUrl: "https://www.ebay.com/itm/123456" };
const readers = (): TrustedMarketplaceCampaignReaders => ({
  readProduct: vi.fn(async id => ({ id, title: "Vintage Camera", category: "Cameras", status: "published", salePausedAt: null })),
  readAvailability: vi.fn(async () => availability),
  readMarketingTags: vi.fn(async () => [{ key: "film-camera" }]),
  readExternalListings: vi.fn(async () => [listing]),
});

describe("ADS-002C.2 verified inventory guard", () => {
  it("blocks the existing product-read default when reservation support is absent", () => {
    expect(verifiedAvailableQuantity({ ...availability, reservedStockSupported: false })).toBeNull();
  });
  it("rejects inconsistent, negative or over-reserved stock", () => {
    expect(verifiedAvailableQuantity({ ...availability, availableQuantity: 2 })).toBeNull();
    expect(verifiedAvailableQuantity({ ...availability, reservedStock: 3 })).toBeNull();
    expect(verifiedAvailableQuantity({ ...availability, physicalStock: -1 })).toBeNull();
    expect(verifiedAvailableQuantity({ ...availability, availableStock: 2 })).toBeNull();
    expect(verifiedAvailableQuantity(null)).toBeNull();
  });
  it("projects an eligible listing only when inventory is reservation-verified", async () => {
    const r = await readMarketplaceCampaignCandidatesForProduct("NOC-000007", readers());
    expect(r.inventoryVerification).toBe("VERIFIED");
    expect(r.projection.candidates).toHaveLength(1);
    expect(r.projection.candidates[0]?.tagKeys).toEqual(["film-camera"]);
    expect(r.projection.spendAuthorized).toBe(false);
  });
  it("blocks unverified stock and does not read tags or listings", async () => {
    const source = readers();
    source.readAvailability = vi.fn(async () => ({ ...availability, reservedStockSupported: false }));
    const result = await readMarketplaceCampaignCandidatesForProduct("NOC-000007", source);
    expect(result.projection.candidates).toEqual([]);
    expect(result.inventoryVerification).toBe("UNVERIFIED");
    expect(source.readExternalListings).not.toHaveBeenCalled();
    expect(source.readMarketingTags).not.toHaveBeenCalled();
  });
  it("blocks fully reserved stock", async () => {
    const source = readers();
    source.readAvailability = vi.fn(async () => ({ ...availability, reservedStock: 2, availableStock: 0, availableQuantity: 0 }));
    expect((await readMarketplaceCampaignCandidatesForProduct("NOC-000007", source)).projection.candidates).toEqual([]);
  });
  it("blocks a mismatched product identity or stock identity", async () => {
    const source = readers();
    source.readAvailability = vi.fn(async () => ({ ...availability, productId: "NOC-WRONG" }));
    expect((await readMarketplaceCampaignCandidatesForProduct("NOC-000007", source)).projection.candidates).toEqual([]);
    const source2 = readers();
    source2.readProduct = vi.fn(async () => ({ id: "NOC-WRONG", title: "Camera", category: null, status: "published", salePausedAt: null }));
    expect((await readMarketplaceCampaignCandidatesForProduct("NOC-000007", source2)).projection.candidates).toEqual([]);
  });
  it("does not touch dependencies for malformed identifiers", async () => {
    const source = readers();
    const result = await readMarketplaceCampaignCandidatesForProduct("../invalid", source);
    expect(result.projection.exclusions[0]?.blocker).toBe("INVALID_PRODUCT_ID");
    expect(source.readProduct).not.toHaveBeenCalled();
  });
});
