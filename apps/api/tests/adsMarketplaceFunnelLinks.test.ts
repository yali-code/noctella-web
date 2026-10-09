import { describe, expect, it } from "vitest";
import { evaluateFunnelLink, safeMarketplaceListingUrl } from "../src/use-cases/ads/marketplaceFunnelLinks";

const product = { status: "published", salePausedAt: null, availableQuantity: 1 };
const listing = { channel: "ebay", externalStatus: "active", externalListingUrl: "https://www.ebay.com/itm/12345" };

describe("ADS-002A marketplace funnel link eligibility", () => {
  it("allows a verified active eBay item and Etsy listing", () => {
    expect(evaluateFunnelLink(product, listing)).toEqual({ eligible: true, channel: "ebay", url: listing.externalListingUrl });
    expect(evaluateFunnelLink(product, { channel: "etsy", externalStatus: "active", externalListingUrl: "https://www.etsy.com/listing/12345" }))
      .toEqual({ eligible: true, channel: "etsy", url: "https://www.etsy.com/listing/12345" });
  });

  it.each(["sold", "reserved", "archived", "draft"])("blocks product status %s", (status) => {
    expect(evaluateFunnelLink({ ...product, status }, listing)).toEqual({ eligible: false, blocker: "PRODUCT_NOT_PUBLISHED" });
  });

  it("blocks paused, missing-stock, and zero-stock products", () => {
    expect(evaluateFunnelLink({ ...product, salePausedAt: "2026-10-09T00:00:00Z" }, listing)).toEqual({ eligible: false, blocker: "PRODUCT_PAUSED" });
    for (const availableQuantity of [null, 0, -1, 0.5]) {
      expect(evaluateFunnelLink({ ...product, availableQuantity }, listing)).toEqual({ eligible: false, blocker: "OUT_OF_STOCK" });
    }
  });

  it("blocks ended listings and other sales channels", () => {
    expect(evaluateFunnelLink(product, { ...listing, externalStatus: "ended" })).toEqual({ eligible: false, blocker: "LISTING_NOT_ACTIVE" });
    expect(evaluateFunnelLink(product, { ...listing, channel: "woocommerce" })).toEqual({ eligible: false, blocker: "UNSUPPORTED_MARKETPLACE" });
  });

  it.each([
    "http://www.ebay.com/itm/123",
    "https://ebay.com.evil.test/itm/123",
    "https://evil.test/itm/123",
    "https://user:pass@www.ebay.com/itm/123",
    "https://www.ebay.com:8443/itm/123",
    "javascript:alert(1)",
    "https://www.ebay.com/",
    " https://www.ebay.com/itm/123",
  ])("rejects unsafe URL %s", (url) => {
    expect(safeMarketplaceListingUrl("ebay", url)).toBeNull();
  });

  it("removes fragments and accepts recognized regional ebay domains", () => {
    expect(safeMarketplaceListingUrl("ebay", "https://www.ebay.de/itm/123#frag")).toBe("https://www.ebay.de/itm/123");
  });
});
