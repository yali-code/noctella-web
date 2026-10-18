// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProductStatus, ProductType, PublishChannel } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById, updateProduct } from "../src/services/products";
import { validatePublish } from "../src/services/publishing";
import { updateProductSchema } from "../src/validation/product";
import { createTestDb } from "./testDb";
import { buildEtsyMediaPlan } from "../../admin/src/lib/etsyMediaPlan";

/** Combined Phase 1 persistence -> canonical detail -> unchanged Phase 2 selector. No providers. */
describe("isolated Etsy Phase 1 + Phase 2 SQLite compatibility", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  beforeEach(async () => {
    db = createTestDb();
    categoryId = (await createCategory(db, { name: "Synthetic Cameras", displayOrder: 0, isActive: true })).id;
  });
  afterEach(() => db.$client.close());
  async function fixture() {
    const p = await createProduct(db, {
      sku: "COMBINED-1", title: "Synthetic camera", type: ProductType.LotItem, status: ProductStatus.Draft,
      categoryId, stockQuantity: 3, priceEur: 100, customsWarning: false, isFeatured: false,
      allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false,
      ebayTitle: "Existing eBay title", ebayDescription: "Existing description", ebayCategory: "123", ebayListingPriceEur: 110,
    });
    await db.insert(schema.productPhotos).values({
      id: "ready", productId: p.id, url: "/images/ready.webp", thumbnailUrl: "", sortOrder: 0, isPrimary: true,
      altText: "Seller photograph", filename: "ready.webp", mimeType: "image/webp", sizeBytes: 1,
      width: 100, height: 100, processingStatus: "Ready",
    });
    return getProductById(db, p.id);
  }

  it("round-trips listing fields and preserves canonical photos, stock, EUR base price and eBay fields", async () => {
    const original = await fixture();
    const movements = await db.select().from(schema.stockMovements);
    const fields = {
      etsyTitle: "Vintage camera", etsyDescription: "Seller description", etsyTags: ["camera"], etsyMaterials: "metal",
      etsyStyle: "vintage", etsyOccasion: "birthday", etsyListingPriceEur: 120, etsyTaxonomyId: "1234",
      etsyWhoMade: "someone_else" as const, etsyIsSupply: false, etsyWhenMade: "1970s", etsyVintageYear: 1972,
      etsyShippingProfileId: "111", etsyProcessingProfileId: "222", etsyReturnPolicyId: "333",
      etsyQuantity: 2, etsyAdsOptIn: false, etsyGpsrManufacturerName: "Seller-supplied manufacturer",
      etsyGpsrManufacturerAddress: "Synthetic address", etsyGpsrManufacturerContact: "seller@example.test",
    };
    await updateProduct(db, original.id, { ...updateProductSchema.parse(fields), expectedUpdatedAt: original.updatedAt });
    const read = await getProductById(db, original.id);
    expect(read).toMatchObject({ ...fields, stockQuantity: 3, priceEur: 100, ebayTitle: "Existing eBay title", ebayDescription: "Existing description", ebayCategory: "123", ebayListingPriceEur: 110 });
    expect(read.marketplaceReadiness.etsy.ready).toBe(true);
    expect(validatePublish(read, PublishChannel.Etsy).valid).toBe(true);
    const photosBefore = structuredClone(read.photos);
    expect(buildEtsyMediaPlan(read.photos)).toMatchObject({ ready: true, eligibleCount: 1, media: [{ photoId: "ready", etsyRank: 1 }] });
    expect(read.photos).toEqual(photosBefore);
    expect(await db.select().from(schema.stockMovements)).toEqual(movements);
    expect(await db.select().from(schema.externalListings)).toEqual([]);
    expect(read.etsyGpsrResponsiblePersonName).toBeUndefined();
    expect(updateProductSchema.safeParse({ etsyListingPriceEur: -1 }).success).toBe(false);
  });

  it("saves incomplete drafts with eligible media without inventing GPSR, enabling Ads or bypassing Etsy validation", async () => {
    const original = await fixture();
    await updateProduct(db, original.id, { etsyTitle: "Incomplete saved draft", etsyTaxonomyId: null, etsyQuantity: 4, expectedUpdatedAt: original.updatedAt });
    const read = await getProductById(db, original.id);
    expect(buildEtsyMediaPlan(read.photos).ready).toBe(true);
    expect(read.marketplaceReadiness.etsy.ready).toBe(false);
    const result = validatePublish(read, PublishChannel.Etsy);
    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.field)).toContain("etsyQuantity");
    expect(read.stockQuantity).toBe(3);
    expect(read.etsyGpsrManufacturerName).toBeUndefined();
    expect(read.etsyGpsrSafetyInformation).toBeUndefined();
    expect(read.etsyAdsOptIn).toBeUndefined();
    expect(await db.select().from(schema.externalListings)).toEqual([]);
    expect(await db.select().from(schema.marketplaceConnections)).toEqual([]);
  });

  it("rejects stale saves without changing the listing, photos or canonical stock", async () => {
    const original = await fixture();
    const movements = await db.select().from(schema.stockMovements);
    await expect(updateProduct(db, original.id, { etsyTitle: "Stale edit", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" })).rejects.toThrow(/changed|version|conflict/i);
    const read = await getProductById(db, original.id);
    expect(read.etsyTitle).toBeUndefined();
    expect(read.stockQuantity).toBe(3);
    expect(read.photos).toEqual(original.photos);
    expect(await db.select().from(schema.stockMovements)).toEqual(movements);
  });
});
