import { ListingStatus, ProductStatus, ProductType, PublishChannel, type Product, type PublishPayload } from "@noctella/shared";
import { describe, expect, it, vi } from "vitest";
import * as apiLib from "./api";
import { channelLabel, getChannelDraftPrice, getChannelDraftTitle, marketplacePreparationApi, payloadSummary, requiresMarketplaceConnection } from "./publishing";

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

  it("requires a marketplace connection only for eBay/Etsy, never for Noctella Web", () => {
    expect(requiresMarketplaceConnection(PublishChannel.Ebay)).toBe(true);
    expect(requiresMarketplaceConnection(PublishChannel.Etsy)).toBe(true);
    expect(requiresMarketplaceConnection(PublishChannel.NoctellaWeb)).toBe(false);
  });
});

describe("marketplacePreparationApi (Sprint 107)", () => {
  it("generate() posts the exact channel payload", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    await marketplacePreparationApi.generate("product-1", PublishChannel.Ebay);
    expect(spy).toHaveBeenCalledWith("/api/products/product-1/marketplace-preparation", { channel: PublishChannel.Ebay });
  });

  it("get() reads the exact channel query", async () => {
    const spy = vi.spyOn(apiLib.api, "get").mockResolvedValue({});
    await marketplacePreparationApi.get("product-1", PublishChannel.Etsy);
    expect(spy).toHaveBeenCalledWith("/api/products/product-1/marketplace-preparation?channel=etsy");
  });

  it("approve() posts the exact admin-submitted final field values", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    const input = { channel: PublishChannel.Ebay, expectedProposalUpdatedAt: "t", title: "Final Title" };
    await marketplacePreparationApi.approve("product-1", input);
    expect(spy).toHaveBeenCalledWith("/api/products/product-1/marketplace-preparation/approve", input);
  });
});
