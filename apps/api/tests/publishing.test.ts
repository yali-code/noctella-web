import { ProductStatus, ProductType, PublishChannel } from "@noctella/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCategory } from "../src/services/categories";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import { buildPublishPreview, SUPPORTED_PUBLISH_CHANNELS, validateProductForPublish } from "../src/services/publishing";
import { createProduct, updateProduct } from "../src/services/products";
import { createTestDb } from "./testDb";

describe("publishing service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Lighting", displayOrder: 0, isActive: true });
    categoryId = category.id;
  });

  function input(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return {
      sku: "PUB-001",
      title: "Art Deco Lamp",
      type: ProductType.UniqueItem,
      status: ProductStatus.Approved,
      categoryId,
      description: "A restored Art Deco table lamp.",
      condition: "Restored",
      stockQuantity: 1,
      priceEur: 500,
      shippingProfile: "standard-eu",
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      images: [{ url: "https://legacy.example/lamp.jpg", sortOrder: 0, isPrimary: true }],
      ...overrides,
    };
  }

  it("declares the supported channels", () => {
    expect(SUPPORTED_PUBLISH_CHANNELS).toEqual([
      PublishChannel.Ebay,
      PublishChannel.Etsy,
      PublishChannel.NoctellaWeb,
    ]);
  });

  it("returns not found for missing products", async () => {
    await expect(validateProductForPublish(db, "missing", PublishChannel.NoctellaWeb)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports common blocking requirements without mutating product data", async () => {
    const product = await createProduct(db, input({ description: undefined, condition: undefined, stockQuantity: 0, images: [] }));
    const before = await updateProduct(db, product.id, {});
    const result = await validateProductForPublish(db, product.id, PublishChannel.NoctellaWeb);
    expect(result.isReady).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["missing_description", "missing_condition", "missing_photo", "invalid_stock"]));
    const after = await updateProduct(db, product.id, {});
    expect(after.stockQuantity).toBe(before.stockQuantity);
    expect(after.status).toBe(before.status);
    expect(after.priceEur).toBe(before.priceEur);
  });

  it("rejects invalid product statuses", async () => {
    const product = await createProduct(db, input({ status: ProductStatus.Sold }));
    const result = await validateProductForPublish(db, product.id, PublishChannel.NoctellaWeb);
    expect(result.errors.map((error) => error.code)).toContain("invalid_status");
  });

  it("separates eBay errors from subtitle warnings", async () => {
    const product = await createProduct(db, input({ ebayCategory: undefined, shippingProfile: undefined, shippingNote: undefined }));
    const result = await validateProductForPublish(db, product.id, PublishChannel.Ebay);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["missing_ebay_category", "missing_ebay_shipping"]));
    expect(result.warnings.map((warning) => warning.code)).toContain("missing_ebay_subtitle");
  });

  it("validates Etsy taxonomy, shipping, and tag warnings", async () => {
    const product = await createProduct(db, input({ shippingProfile: undefined, shippingNote: undefined, etsyTags: ["lamp"] }));
    const result = await validateProductForPublish(db, product.id, PublishChannel.Etsy);
    expect(result.errors.map((error) => error.code)).toContain("missing_etsy_shipping");
    expect(result.warnings.map((warning) => warning.code)).toContain("insufficient_etsy_tags");
  });

  it("validates Noctella Web readiness", async () => {
    const product = await createProduct(db, input());
    const result = await validateProductForPublish(db, product.id, PublishChannel.NoctellaWeb);
    expect(result.isReady).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("builds a successful preview from backend data and ordered legacy images", async () => {
    const product = await createProduct(db, input({ title: "Backend Title", images: [
      { url: "https://legacy.example/second.jpg", sortOrder: 1, isPrimary: false },
      { url: "https://legacy.example/primary.jpg", sortOrder: 2, isPrimary: true },
    ] }));
    const preview = await buildPublishPreview(db, product.id, PublishChannel.NoctellaWeb);
    expect(preview.title).toBe("Backend Title");
    expect(preview.photos.map((photo) => photo.url)).toEqual(["https://legacy.example/primary.jpg", "https://legacy.example/second.jpg"]);
  });

  it("rejects preview when blocking errors exist", async () => {
    const product = await createProduct(db, input({ images: [] }));
    await expect(buildPublishPreview(db, product.id, PublishChannel.NoctellaWeb)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("does not perform network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const product = await createProduct(db, input());
    await validateProductForPublish(db, product.id, PublishChannel.NoctellaWeb);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
