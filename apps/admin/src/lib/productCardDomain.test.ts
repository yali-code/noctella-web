import { describe, expect, it } from "vitest";
import { buildProductCardSummary, formatEur, PRODUCT_CARD_SECTIONS, type ProductCardSource } from "./productCardDomain";

const source: ProductCardSource = {
  id: "product-1",
  sku: "ART-000001",
  title: "Moon vase",
  slug: "moon-vase",
  status: "draft",
  type: "unique",
  priceEur: 125,
  stockQuantity: 1,
  description: "  A singular object.  ",
  photos: [],
  marketplaceReadiness: {
    ebay: { ready: false, missingFields: ["ebayTitle"] },
    etsy: { ready: false, missingFields: ["etsyTitle"] },
    woocommerce: { ready: true, missingFields: [] },
  },
};

describe("Product Card 2.0 domain", () => {
  it("defines stable, ordered Product Card sections", () => {
    expect(PRODUCT_CARD_SECTIONS).toEqual(["identity", "commercial", "inventory", "content", "media", "publishing"]);
  });

  it("projects authoritative identity, EUR price, inventory and optional channel readiness", () => {
    const card = buildProductCardSummary(source);
    expect(card.identity).toEqual({ id: "product-1", sku: "ART-000001", title: "Moon vase", slug: "moon-vase" });
    expect(card.commercial).toEqual({ currency: "EUR", price: 125 });
    expect(card.inventory.quantity).toBe(1);
    expect(card.content.description).toBe("A singular object.");
    expect(card.publishing.woocommerce.ready).toBe(true);
  });

  it("selects the canonical primary photo and preserves an explicit empty state", () => {
    const secondary = { id: "photo-1", isPrimary: false } as ProductCardSource["photos"][number];
    const primary = { id: "photo-2", isPrimary: true } as ProductCardSource["photos"][number];
    expect(buildProductCardSummary({ ...source, photos: [secondary, primary] }).media.primaryPhoto).toBe(primary);
    expect(buildProductCardSummary(source).media.primaryPhoto).toBeNull();
  });

  it("formats only EUR and keeps missing pricing explicit", () => {
    expect(formatEur(null)).toBe("No price set");
    expect(formatEur(12.5)).toMatch(/€12\.50/);
  });
});
