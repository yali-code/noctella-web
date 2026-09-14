import { describe, expect, it } from "vitest";
import { buildHistoricalPublishPayload, buildProductPublicationEnvelope, PRODUCT_PUBLICATION_TARGETS, WOO_FIELD_OWNERSHIP } from "../src/integrations/productPublishingFoundation";
import { PublishChannel } from "@noctella/shared";

const product = {
  id: "p1", sku: "ART-000001", title: "Moon vase", slug: "moon-vase", status: "approved",
  stockQuantity: 1, priceEur: 100, updatedAt: "2026-09-14T00:00:00.000Z",
} as any;

describe("shared Product publishing foundation", () => {
  it("registers Noctella Web and WooCommerce as distinct targets", () => {
    expect(PRODUCT_PUBLICATION_TARGETS).toEqual(["noctella_web", "ebay", "etsy", "woocommerce"]);
  });

  it.each(PRODUCT_PUBLICATION_TARGETS)("keeps Product identity, EUR, and inventory authoritative for %s", (target) => {
    const envelope = buildProductPublicationEnvelope(product, [], target);
    expect(envelope).toMatchObject({ target, sourceProductId: "p1", sourceUpdatedAt: product.updatedAt, currency: "EUR", inventory: { managedBy: "noctella", quantity: 1 } });
  });

  it("uses optional marketplace overrides without making them core requirements", () => {
    expect(buildProductPublicationEnvelope(product, [], "ebay").payload).toMatchObject({ title: "Moon vase", priceEur: 100 });
    expect(buildProductPublicationEnvelope({ ...product, etsyTitle: "Etsy moon" }, [], "etsy").payload).toMatchObject({ title: "Etsy moon" });
  });

  it("feeds the historical payload contract while retaining established woo fields as Noctella Web defaults", () => {
    const owned = { ...product, wooProductName: "Web moon", wooListingPriceEur: 120 };
    expect(WOO_FIELD_OWNERSHIP).toBe("noctella_web_defaults_for_woocommerce");
    expect(buildHistoricalPublishPayload(owned, [], PublishChannel.NoctellaWeb)).toMatchObject({ productId: "p1", title: "Web moon", priceEur: 120 });
    expect(buildProductPublicationEnvelope(owned, [], "woocommerce").payload).toMatchObject({ name: "Web moon", regular_price: "120.00" });
  });
});
