import { ListingStatus, ProductStatus, ProductType, PublishChannel, type Product, type PublishPayload } from "@noctella/shared";
import { describe, expect, it } from "vitest";
import { channelLabel, getChannelDraftPrice, getChannelDraftTitle, payloadSummary } from "./publishing";

const product: Product = {
  id: "p1", sku: "SKU", title: "Base title", slug: "base-title", type: ProductType.UniqueItem, status: ProductStatus.Draft, stockQuantity: 1, priceEur: 100, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, ebayTitle: "eBay title", ebayListingPriceEur: 125, etsyTitle: "Etsy title", etsyListingPriceEur: 110, wooProductName: "Web title", wooListingPriceEur: 105, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("admin publishing helpers", () => {
  it("labels channels", () => {
    expect(channelLabel(PublishChannel.Ebay)).toBe("eBay");
    expect(channelLabel(PublishChannel.NoctellaWeb)).toBe("Noctella Web");
  });

  it("selects channel-specific draft title and price", () => {
    expect(getChannelDraftTitle(product, PublishChannel.Etsy)).toBe("Etsy title");
    expect(getChannelDraftPrice(product, PublishChannel.Ebay)).toBe(125);
  });

  it("summarizes payload availability", () => {
    expect(payloadSummary(undefined)).toContain("unavailable");
    const payload: PublishPayload = { productId: "p1", channel: PublishChannel.Ebay, listingStatus: ListingStatus.Draft, title: "eBay title", description: "Description", priceEur: 125, images: [], metadata: {} };
    expect(payloadSummary(payload)).toContain("€125.00");
  });
});
