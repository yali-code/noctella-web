import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { BadRequestError, ConflictError, ProductVersionConflictError } from "../src/services/errors";
import { archiveProduct, createProduct, getProductById, updateProduct } from "../src/services/products";
import { createProductSchema, updateProductRequestSchema } from "../src/validation/product";
import { handleRouteError } from "../src/routes/errorHandler";
import { createTestDb } from "./testDb";

describe("product service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, {
      name: "Watches & Timepieces",
      displayOrder: 0,
      isActive: true,
    });
    categoryId = category.id;
  });

  function baseInput(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return {
      sku: "SKU-001",
      title: "Vintage Chronograph",
      type: ProductType.UniqueItem,
      status: ProductStatus.Draft,
      categoryId,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 1200,
      ...overrides,
    };
  }

  it("creates a product with a derived slug and default stock", async () => {
    const product = await createProduct(db, baseInput());
    expect(product.slug).toBe("vintage-chronograph");
    expect(product.stockQuantity).toBe(1);
    expect(product.status).toBe(ProductStatus.Draft);
  });

  it("updates a product's title and price", async () => {
    const product = await createProduct(db, baseInput());
    const updated = await updateProduct(db, product.id, { title: "Vintage Chronograph 1960s", priceEur: 1500 });
    expect(updated.title).toBe("Vintage Chronograph 1960s");
    expect(updated.priceEur).toBe(1500);
  });

  it("rejects a duplicate SKU on creation", async () => {
    await createProduct(db, baseInput());
    await expect(createProduct(db, baseInput({ title: "Another Item" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  /**
   * Sprint 98: a duplicate title (different SKU) derives the same slug, which the database
   * rejects via its unique constraint on `products.slug` - no application-level pre-check exists
   * for slug (only existsBySku does). This proves the raw INSERT failure is translated into a
   * clean canonical conflict instead of an unhandled exception, that Product A is left untouched,
   * that no partial Product/StockMovement is created for the failed attempt, and that a later
   * unique title still succeeds.
   */
  it("rejects a duplicate title's derived slug on creation from a different SKU, without creating a partial Product or StockMovement", async () => {
    const productA = await createProduct(db, baseInput());
    const productsBefore = (await db.select().from(schema.products)).length;
    const movementsBefore = (await db.select().from(schema.stockMovements)).length;

    let caught: unknown;
    try {
      await createProduct(db, baseInput({ sku: "SKU-002" })); // same default title -> same derived slug
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as Error).message).toBe("A product with this SKU or slug already exists.");

    const unchanged = await getProductById(db, productA.id);
    expect(unchanged.updatedAt).toBe(productA.updatedAt);
    expect((await db.select().from(schema.products)).length).toBe(productsBefore);
    expect((await db.select().from(schema.stockMovements)).length).toBe(movementsBefore);

    const productC = await createProduct(db, baseInput({ sku: "SKU-003", title: "Vintage Chronograph Two" }));
    expect(productC.slug).toBe("vintage-chronograph-two");
  });

  it("rejects a duplicate SKU on update", async () => {
    const first = await createProduct(db, baseInput());
    const second = await createProduct(db, baseInput({ sku: "SKU-002", title: "Second Item" }));
    await expect(updateProduct(db, second.id, { sku: first.sku })).rejects.toBeInstanceOf(ConflictError);
  });

  it("archives a product instead of deleting it", async () => {
    const product = await createProduct(db, baseInput());
    const archived = await archiveProduct(db, product.id);
    expect(archived.status).toBe(ProductStatus.Archived);
  });

  it("a partial update does not reset unrelated boolean flags to false", async () => {
    const product = await createProduct(db, baseInput({ showInArchiveAfterSale: true, isFeatured: true }));
    const updated = await updateProduct(db, product.id, { status: ProductStatus.Sold });
    expect(updated.showInArchiveAfterSale).toBe(true);
    expect(updated.isFeatured).toBe(true);
    expect(updated.status).toBe(ProductStatus.Sold);
  });

  it("enforces Unique Item stock quantity cannot exceed 1", async () => {
    await expect(
      createProduct(db, baseInput({ type: ProductType.UniqueItem, stockQuantity: 2 })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("defaults Unique Item stock quantity to 1 when omitted", async () => {
    const product = await createProduct(db, baseInput({ type: ProductType.UniqueItem }));
    expect(product.stockQuantity).toBe(1);
  });

  it("creates a Lot Item with an optional lot item count", async () => {
    const product = await createProduct(
      db,
      baseInput({ sku: "LOT-001", type: ProductType.LotItem, lotItemCount: 12 }),
    );
    expect(product.type).toBe(ProductType.LotItem);
    expect(product.stockQuantity).toBe(1);
    expect(product.lotItemCount).toBe(12);
  });

  it("rejects creation when category does not exist", async () => {
    await expect(
      createProduct(db, baseInput({ categoryId: "missing-category" })),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects more than one primary image", async () => {
    await expect(
      createProduct(
        db,
        baseInput({
          images: [
            { url: "https://example.com/a.jpg", sortOrder: 0, isPrimary: true },
            { url: "https://example.com/b.jpg", sortOrder: 1, isPrimary: true },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("zod schema rejects missing required fields with clear messages", () => {
    const result = createProductSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.path.join("."));
      expect(messages).toContain("sku");
      expect(messages).toContain("title");
      expect(messages).toContain("priceEur");
    }
  });

  it("zod schema rejects a non-positive EUR price", () => {
    const result = createProductSchema.safeParse(
      baseInput({ priceEur: 0 }) as unknown as Record<string, unknown>,
    );
    expect(result.success).toBe(false);
  });

  it("creates a product with no marketplace fields and reports all marketplaces not ready", async () => {
    const product = await createProduct(db, baseInput());
    expect(product.marketplaceReadiness.ebay.ready).toBe(false);
    expect(product.marketplaceReadiness.ebay.missingFields).toEqual(
      expect.arrayContaining(["title", "description", "category", "listingPriceEur"]),
    );
    expect(product.marketplaceReadiness.etsy.ready).toBe(false);
    expect(product.marketplaceReadiness.woocommerce.ready).toBe(false);
  });

  it("saves optional eBay/Etsy/WooCommerce fields without requiring them", async () => {
    const product = await createProduct(
      db,
      baseInput({
        ebayTitle: "Vintage Chronograph — 1960s",
        ebayDescription: "A rare find.",
        ebayCategory: "Jewelry & Watches",
        ebayListingPriceEur: 1300,
        etsyTitle: "Vintage Chronograph",
        etsyTags: ["vintage", "watch"],
        wooProductName: "Vintage Chronograph",
      }),
    );
    expect(product.ebayTitle).toBe("Vintage Chronograph — 1960s");
    expect(product.etsyTags).toEqual(["vintage", "watch"]);
    expect(product.wooProductName).toBe("Vintage Chronograph");
    // eBay has all 4 required fields filled -> ready
    expect(product.marketplaceReadiness.ebay.ready).toBe(true);
    // Etsy is missing description + listingPriceEur -> not ready, but doesn't block save
    expect(product.marketplaceReadiness.etsy.ready).toBe(false);
    expect(product.marketplaceReadiness.etsy.missingFields).toEqual(
      expect.arrayContaining(["description", "listingPriceEur"]),
    );
  });

  it("updates marketplace fields independently via updateProduct", async () => {
    const product = await createProduct(db, baseInput());
    const updated = await updateProduct(db, product.id, {
      etsyTitle: "Updated Etsy Title",
      etsyDescription: "Updated description",
      etsyListingPriceEur: 900,
    });
    expect(updated.etsyTitle).toBe("Updated Etsy Title");
    expect(updated.marketplaceReadiness.etsy.ready).toBe(true);
    // eBay untouched and still not ready
    expect(updated.marketplaceReadiness.ebay.ready).toBe(false);
  });

  describe("Sprint 88: manual Product optimistic concurrency (ADR-017)", () => {
    it("route request schema rejects an omitted expectedUpdatedAt (HTTP 400 at the route)", () => {
      const result = updateProductRequestSchema.safeParse({ title: "New Title" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("expectedUpdatedAt");
      }
    });

    it("route request schema accepts editable fields plus a required expectedUpdatedAt", () => {
      const result = updateProductRequestSchema.safeParse({ title: "New Title", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" });
      expect(result.success).toBe(true);
    });

    it("stale expectedUpdatedAt throws ProductVersionConflictError carrying productId/expectedUpdatedAt/currentUpdatedAt", async () => {
      const product = await createProduct(db, baseInput());
      await expect(
        updateProduct(db, product.id, { title: "Attempt", expectedUpdatedAt: "stale-token" }),
      ).rejects.toBeInstanceOf(ProductVersionConflictError);
      let caught: unknown;
      try {
        await updateProduct(db, product.id, { title: "Attempt", expectedUpdatedAt: "stale-token" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        productId: product.id,
        expectedUpdatedAt: "stale-token",
        currentUpdatedAt: product.updatedAt,
      });
    });

    it("maps ProductVersionConflictError to HTTP 409 with the exact PRODUCT_VERSION_CONFLICT response contract", async () => {
      const product = await createProduct(db, baseInput());
      let caught: unknown;
      try {
        await updateProduct(db, product.id, { title: "Attempt", expectedUpdatedAt: "stale-token" });
      } catch (err) {
        caught = err;
      }
      const status = vi.fn();
      const json = vi.fn();
      const res = { status: status.mockReturnValue({ json }) } as any;
      handleRouteError(caught, res);
      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        error: "This product changed after you opened it. Reload the latest version before saving again.",
        code: "PRODUCT_VERSION_CONFLICT",
        productId: product.id,
        expectedUpdatedAt: "stale-token",
        currentUpdatedAt: product.updatedAt,
      });
    });

    it("a stale update mutates neither the Product nor its stock quantity", async () => {
      const product = await createProduct(db, baseInput({ type: ProductType.LotItem, stockQuantity: 3 }));
      await expect(
        updateProduct(db, product.id, { title: "Should not apply", stockQuantity: 9, expectedUpdatedAt: "stale-token" }),
      ).rejects.toBeInstanceOf(ProductVersionConflictError);
      const { getProductById } = await import("../src/services/products");
      const unchanged = await getProductById(db, product.id);
      expect(unchanged.title).toBe(product.title);
      expect(unchanged.stockQuantity).toBe(3);
      expect(unchanged.updatedAt).toBe(product.updatedAt);
    });

    it("a successful update with the correct token returns a new updatedAt, and a second update using that returned token succeeds", async () => {
      const product = await createProduct(db, baseInput());
      const first = await updateProduct(db, product.id, { title: "First Save", expectedUpdatedAt: product.updatedAt });
      expect(first.updatedAt).not.toBe(product.updatedAt);
      const second = await updateProduct(db, product.id, { title: "Second Save", expectedUpdatedAt: first.updatedAt });
      expect(second.title).toBe("Second Save");
    });

    it("advances updatedAt even under a frozen same-millisecond clock", async () => {
      const product = await createProduct(db, baseInput());
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(product.updatedAt));
        const updated = await updateProduct(db, product.id, { title: "Frozen Clock Save", expectedUpdatedAt: product.updatedAt });
        expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(product.updatedAt).getTime());
      } finally {
        vi.useRealTimers();
      }
    });

    it("duplicate SKU on update remains an ordinary ConflictError, not a ProductVersionConflictError", async () => {
      const first = await createProduct(db, baseInput());
      const second = await createProduct(db, baseInput({ sku: "SKU-002", title: "Second Item" }));
      await expect(updateProduct(db, second.id, { sku: first.sku })).rejects.toBeInstanceOf(ConflictError);
      await expect(updateProduct(db, second.id, { sku: first.sku })).rejects.not.toBeInstanceOf(ProductVersionConflictError);
    });
  });
});
