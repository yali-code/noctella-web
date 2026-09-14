import { describe, expect, it } from "vitest";
import { prepareOptionalProductSeo } from "../src/integrations/productAiSeoPreparation";
import { buildProductPublicationEnvelope, PRODUCT_PUBLICATION_TARGETS } from "../src/integrations/productPublishingFoundation";
import { buildWooCommerceProductDraft } from "../src/integrations/woocommerce/productAdapter";

const authoritativeProduct = Object.freeze({
  id: "product-000001",
  sku: "DEC-000001",
  title: "Noctella moon vessel",
  slug: "noctella-moon-vessel",
  type: "unique",
  status: "approved",
  stockQuantity: 1,
  priceEur: 240,
  description: "Canonical Product description",
  seoTitle: "Curated SEO title",
  updatedAt: "2026-09-14T00:00:00.000Z",
}) as any;

describe("Product Card and publishing foundations", () => {
  it("uses the category-coded stable SKU as the downstream barcode identity", () => {
    const woo = buildWooCommerceProductDraft(authoritativeProduct);
    expect(woo.sku).toBe("DEC-000001");
    expect(woo.meta_data).toContainEqual({ key: "_noctella_product_id", value: "product-000001" });
  });

  it("never turns channel preparation into a second inventory authority", () => {
    for (const target of PRODUCT_PUBLICATION_TARGETS) {
      const envelope = buildProductPublicationEnvelope(authoritativeProduct, [], target);
      expect(envelope.inventory).toEqual({ managedBy: "noctella", quantity: 1 });
      expect(envelope.sourceProductId).toBe(authoritativeProduct.id);
    }
  });

  it("keeps Noctella Web semantically distinct from the WooCommerce adapter", () => {
    const direct = buildProductPublicationEnvelope(authoritativeProduct, [], "noctella_web");
    const woo = buildProductPublicationEnvelope(authoritativeProduct, [], "woocommerce");
    expect(direct.payload).toEqual({ productId: "product-000001", status: "approved" });
    expect(woo.payload).toHaveProperty("manage_stock", true);
  });

  it("keeps AI optional and manual SEO authoritative", () => {
    expect(prepareOptionalProductSeo(authoritativeProduct, { seoTitle: "Generated replacement" })).toMatchObject({
      seoTitle: "Curated SEO title",
      source: { seoTitle: "manual" },
    });
  });

  it("does not mutate the authoritative Product while preparing downstream data", () => {
    expect(() => {
      buildWooCommerceProductDraft(authoritativeProduct);
      buildProductPublicationEnvelope(authoritativeProduct, [], "etsy");
      prepareOptionalProductSeo(authoritativeProduct);
    }).not.toThrow();
    expect(Object.isFrozen(authoritativeProduct)).toBe(true);
  });
});
