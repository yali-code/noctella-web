import { ListingStatus, ProductStatus, ProductType, PublishChannel } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCategory } from "../src/services/categories";
import { buildPublishPayload, buildPublishPreview, validatePublish } from "../src/services/publishing";
import { createProduct, getProductById } from "../src/services/products";
import { productPhotos } from "../src/db/schema";
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

  // Sprint 87: inserts a real ProductPhoto row (never the legacy productImages table) and
  // re-fetches the product through getProductById so `.photos` reflects genuine persisted data,
  // matching how every real publish call site (executePublish/getPublishPreview) actually sees it.
  async function seedPrimaryPhoto(productId: string, overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    await db.insert(productPhotos).values({
      id: overrides.id ?? `ph-${Math.random().toString(36).slice(2, 10)}`,
      productId,
      url: "/images/product-photos/moon-watch.webp",
      thumbnailUrl: "/images/product-photos/moon-watch-thumb.webp",
      altText: null,
      sortOrder: 0,
      isPrimary: true,
      filename: "moon-watch.webp",
      mimeType: "image/webp",
      sizeBytes: 2048,
      width: 800,
      height: 600,
      processingStatus: "Ready",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as any);
    return getProductById(db, productId);
  }

  it("keeps marketplace fields optional at product creation but validates them for publish", async () => {
    const product = await createProduct(db, base());
    const validation = validatePublish(product, PublishChannel.Ebay);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((item) => item.field)).toEqual(expect.arrayContaining(["ebayTitle", "ebayDescription", "ebayCategory", "ebayListingPriceEur"]));
    expect(validation.warnings.every((item) => item.severity === "warning")).toBe(true);
  });

  it("builds an eBay publish preview with separated errors and warnings", async () => {
    const created = await createProduct(db, base({ ebayTitle: "Moon Watch", ebayDescription: "Rare watch", ebayCategory: "Watches", ebayListingPriceEur: 650, ebayListingStatus: ListingStatus.Draft }));
    const product = await seedPrimaryPhoto(created.id);
    const preview = buildPublishPreview(product, PublishChannel.Ebay);
    expect(preview.validation.valid).toBe(true);
    expect(preview.validation.errors).toEqual([]);
    expect(preview.payload?.title).toBe("Moon Watch");
    expect(preview.payload?.priceEur).toBe(650);
  });

  it("validates Etsy and Noctella Web requirements", async () => {
    const created = await createProduct(db, base({ etsyTitle: "Moon", etsyDescription: "Rare", etsyTags: ["watch"], etsyListingPriceEur: 600, wooProductName: "Moon", wooShortDescription: "Short", wooLongDescription: "Long", wooListingPriceEur: 550 }));
    const product = await seedPrimaryPhoto(created.id);
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

  describe("Sprint 87: Primary product photo publish requirement", () => {
    function fullyValidInput(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
      return base({
        ebayTitle: "Moon Watch", ebayDescription: "Rare watch", ebayCategory: "Watches", ebayListingPriceEur: 650,
        etsyTitle: "Moon", etsyDescription: "Rare", etsyTags: ["watch"], etsyListingPriceEur: 600,
        wooProductName: "Moon", wooShortDescription: "Short", wooLongDescription: "Long", wooListingPriceEur: 550,
        ...overrides,
      });
    }

    it("1. no photos: invalid, with type primary_product_photo_required, severity error, field photos", async () => {
      const product = await createProduct(db, fullyValidInput());
      const validation = validatePublish(product, PublishChannel.NoctellaWeb);
      expect(validation.valid).toBe(false);
      const photoIssue = validation.errors.find((e) => e.type === "primary_product_photo_required");
      expect(photoIssue).toMatchObject({ type: "primary_product_photo_required", severity: "error", field: "photos" });
    });

    it("2. photos exist but none Primary: invalid", async () => {
      const created = await createProduct(db, fullyValidInput());
      const product = await seedPrimaryPhoto(created.id, { id: "ph-nonprimary", isPrimary: false, processingStatus: "Ready" });
      expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(false);
    });

    it("3. Primary Ready: valid, given all other required publish fields are valid", async () => {
      const created = await createProduct(db, fullyValidInput());
      const product = await seedPrimaryPhoto(created.id, { processingStatus: "Ready" });
      expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(true);
    });

    it("4. Primary Processing: valid", async () => {
      const created = await createProduct(db, fullyValidInput());
      const product = await seedPrimaryPhoto(created.id, { processingStatus: "Processing" });
      expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(true);
    });

    it("5. Primary Failed: invalid", async () => {
      const created = await createProduct(db, fullyValidInput());
      const product = await seedPrimaryPhoto(created.id, { processingStatus: "Failed" });
      expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(false);
    });

    it("6. non-primary Ready photo only: invalid", async () => {
      const created = await createProduct(db, fullyValidInput());
      const product = await seedPrimaryPhoto(created.id, { id: "ph-nonprimary-ready", isPrimary: false, processingStatus: "Ready" });
      expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(false);
    });

    it("7. Primary Failed plus non-primary Ready: invalid", async () => {
      const created = await createProduct(db, fullyValidInput());
      const now = new Date().toISOString();
      await db.insert(productPhotos).values({ id: "ph-primary-failed", productId: created.id, url: "/images/product-photos/a.webp", thumbnailUrl: "/images/product-photos/a-thumb.webp", altText: null, sortOrder: 0, isPrimary: true, filename: "a.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1, processingStatus: "Failed", createdAt: now, updatedAt: now } as any);
      await db.insert(productPhotos).values({ id: "ph-nonprimary-ready-2", productId: created.id, url: "/images/product-photos/b.webp", thumbnailUrl: "/images/product-photos/b-thumb.webp", altText: null, sortOrder: 1, isPrimary: false, filename: "b.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1, processingStatus: "Ready", createdAt: now, updatedAt: now } as any);
      const product = await getProductById(db, created.id);
      expect(validatePublish(product, PublishChannel.NoctellaWeb).valid).toBe(false);
    });

    it("8. photo error coexists with existing marketplace-field validations without erasing them; warnings remain warnings", async () => {
      const product = await createProduct(db, base());
      const validation = validatePublish(product, PublishChannel.Ebay);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.type === "primary_product_photo_required")).toBe(true);
      expect(validation.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["ebayTitle", "ebayDescription", "ebayCategory", "ebayListingPriceEur", "photos"]));
      expect(validation.warnings.every((item) => item.severity === "warning")).toBe(true);
    });
  });
});
