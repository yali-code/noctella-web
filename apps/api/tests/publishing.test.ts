import { ListingStatus, ProductStatus, ProductType, PublishChannel } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { buildPublishPayload, buildPublishPreview, validatePublish } from "../src/services/publishing";
import { createProduct } from "../src/services/products";
import { publishRequestSchema } from "../src/validation/publishing";
import { createTestDb } from "./testDb";

describe("publishing service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true })).id;
  });

  function base(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return { sku: "PUB-1", title: "Moon Watch", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, priceEur: 500, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, ...overrides };
  }

  it("keeps marketplace fields optional at product creation but validates them for publish", async () => {
    const product = await createProduct(db, base());
    const validation = validatePublish(product, PublishChannel.Ebay);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((item) => item.field)).toEqual(expect.arrayContaining(["ebayTitle", "ebayDescription", "ebayCategory", "ebayListingPriceEur"]));
    expect(validation.warnings.every((item) => item.severity === "warning")).toBe(true);
  });

  it("builds an eBay publish preview with separated errors and warnings", async () => {
    const product = await createProduct(db, base({ ebayTitle: "Moon Watch", ebayDescription: "Rare watch", ebayCategory: "Watches", ebayListingPriceEur: 650, ebayListingStatus: ListingStatus.Draft }));
    const preview = buildPublishPreview(product, PublishChannel.Ebay);
    expect(preview.validation.valid).toBe(true);
    expect(preview.validation.errors).toEqual([]);
    expect(preview.payload?.title).toBe("Moon Watch");
    expect(preview.payload?.priceEur).toBe(650);
  });

  it("validates Etsy and Noctella Web requirements", async () => {
    const product = await createProduct(db, base({ etsyTitle: "Moon", etsyDescription: "Rare", etsyTags: ["watch"], etsyListingPriceEur: 600, wooProductName: "Moon", wooShortDescription: "Short", wooLongDescription: "Long", wooListingPriceEur: 550 }));
    expect(validatePublish(product, PublishChannel.Etsy).valid).toBe(true);
    expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(true);
  });

  it("builds marketplace-neutral payloads without external publishing", async () => {
    const product = await createProduct(db, base({ wooProductName: "Site Moon", wooShortDescription: "Short", wooLongDescription: "Long", wooListingPriceEur: 550 }));
    const payload = buildPublishPayload(product, [], PublishChannel.NoctellaWeb);
    expect(payload.channel).toBe(PublishChannel.NoctellaWeb);
    expect(payload.listingStatus).toBe(ListingStatus.Draft);
    expect(payload.metadata.shortDescription).toBe("Short");
  });

  it("parses API publish requests by channel", () => {
    expect(publishRequestSchema.parse({ channel: PublishChannel.Etsy }).channel).toBe(PublishChannel.Etsy);
    expect(() => publishRequestSchema.parse({ channel: "amazon" })).toThrow();
  });
});
