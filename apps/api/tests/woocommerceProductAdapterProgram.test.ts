import { describe, expect, it } from "vitest";
import { buildWooCommerceProductDraft } from "../src/integrations/woocommerce/productAdapter";

const product = {
  id: "p1",
  sku: "ART-000001",
  title: "Moon vase",
  slug: "moon-vase",
  priceEur: 100,
  wooListingPriceEur: 125,
  stockQuantity: 1,
  description: "Canonical description",
} as any;

describe("WooCommerce Product adapter foundation", () => {
  it("maps stable identity, EUR price, and authoritative inventory", () => {
    const draft = buildWooCommerceProductDraft(product);
    expect(draft).toMatchObject({ sku: "ART-000001", name: "Moon vase", slug: "moon-vase", regular_price: "125.00", manage_stock: true, stock_quantity: 1 });
    expect(draft.meta_data).toContainEqual({ key: "_noctella_currency", value: "EUR" });
  });

  it("keeps optional channel fields optional and falls back to canonical content", () => {
    expect(buildWooCommerceProductDraft({ ...product, wooListingPriceEur: undefined }).description).toBe("Canonical description");
    expect(buildWooCommerceProductDraft({ ...product, priceEur: null, wooListingPriceEur: undefined })).not.toHaveProperty("regular_price");
  });

  it("orders primary media first without mutating authoritative photos", () => {
    const photos = [
      { id: "second", url: "second.webp", sortOrder: 1, isPrimary: false },
      { id: "primary", url: "primary.webp", sortOrder: 2, isPrimary: true, altText: "Hero" },
    ] as any;
    expect(buildWooCommerceProductDraft(product, photos).images).toEqual([
      { src: "primary.webp", alt: "Hero" },
      { src: "second.webp", alt: "Moon vase" },
    ]);
    expect(photos[0].id).toBe("second");
  });

  it("maps zero stock and positive stock as downstream Noctella inventory snapshots", () => {
    expect(buildWooCommerceProductDraft({ ...product, stockQuantity: 0 }).stock_quantity).toBe(0);
    expect(buildWooCommerceProductDraft({ ...product, stockQuantity: 7 }).stock_quantity).toBe(7);
  });

  it("maps representative optional Woo content without inventing absent fields", () => {
    const draft = buildWooCommerceProductDraft({ ...product, wooProductName: "Woo Moon", wooSlug: "woo-moon", wooLongDescription: "Woo long", wooShortDescription: "Woo short" });
    expect(draft).toMatchObject({ sku: "ART-000001", name: "Woo Moon", slug: "woo-moon", description: "Woo long", short_description: "Woo short", regular_price: "125.00" });
    expect(buildWooCommerceProductDraft({ ...product, wooShortDescription: undefined }).short_description).toBe("");
  });
});
