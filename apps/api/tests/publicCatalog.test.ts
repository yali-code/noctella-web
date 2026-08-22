import { ProductStatus, ProductType } from "@noctella/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createCollection } from "../src/services/collections";
import { createProduct, listProducts, updateProduct } from "../src/services/products";
import {
  getPublicCategoryBySlug,
  getPublicProductBySlug,
  listArchiveProducts,
  listPublicCategories,
  listPublicProducts,
  listRelatedProducts,
} from "../src/services/publicCatalog";
import { NotFoundError } from "../src/services/errors";
import { createTestDb } from "./testDb";

describe("public catalog service", () => {
  let db: ReturnType<typeof createTestDb>;
  let categoryId: string;
  let collectionId: string;

  beforeEach(async () => {
    db = createTestDb();
    const category = await createCategory(db, { name: "Watches", displayOrder: 0, isActive: true });
    categoryId = category.id;
    const collection = await createCollection(db, {
      name: "Gentleman Series",
      displayOrder: 0,
      isActive: true,
    });
    collectionId = collection.id;
  });

  function baseInput(overrides: Partial<Parameters<typeof createProduct>[1]> = {}) {
    return {
      sku: `SKU-${Math.random().toString(36).slice(2, 8)}`,
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

  it("only shows Published products in the public list", async () => {
    await createProduct(db, baseInput({ title: "Draft Item", status: ProductStatus.Draft }));
    await createProduct(db, baseInput({ title: "Pending Item", status: ProductStatus.PendingReview }));
    const published = await createProduct(
      db,
      baseInput({ title: "Published Item", status: ProductStatus.Published }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(published.id);
  });

  it("hides a paused Published Product from list, detail, and related products while preserving internal retrieval",async()=>{const visible=await createProduct(db,baseInput({title:"Visible",status:ProductStatus.Published})),paused=await createProduct(db,baseInput({title:"Paused",status:ProductStatus.Published,categoryId}));expect((await listPublicProducts(db,{page:1,pageSize:20,sort:"newest"})).items.map(p=>p.id)).toEqual(expect.arrayContaining([visible.id,paused.id]));await getPublicProductBySlug(db,paused.slug);await db.update(schema.products).set({salePausedAt:new Date().toISOString()}).where(eq(schema.products.id,paused.id));const listed=await listPublicProducts(db,{page:1,pageSize:20,sort:"newest"});expect(listed.items.map(p=>p.id)).toContain(visible.id);expect(listed.items.map(p=>p.id)).not.toContain(paused.id);await expect(getPublicProductBySlug(db,paused.slug)).rejects.toBeInstanceOf(NotFoundError);expect((await listRelatedProducts(db,visible.id,categoryId,10)).map(p=>p.id)).not.toContain(paused.id);await expect(listProducts(db,{page:1,pageSize:20})).resolves.toMatchObject({items:expect.arrayContaining([expect.objectContaining({id:paused.id})])});});

  it("never exposes Draft/PendingReview/Approved/Reserved/Archived/Returned statuses via getPublicProductBySlug", async () => {
    const hiddenStatuses = [
      ProductStatus.Draft,
      ProductStatus.AiPrepared,
      ProductStatus.PendingReview,
      ProductStatus.Approved,
      ProductStatus.Reserved,
      ProductStatus.Archived,
      ProductStatus.Returned,
    ];
    for (const status of hiddenStatuses) {
      const product = await createProduct(
        db,
        baseInput({ sku: `SKU-${status}`, title: `Hidden Item ${status}`, status }),
      );
      await expect(getPublicProductBySlug(db, product.slug)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("does not expose internal fields (sku, purchaseCost, internalNotes) on the public product", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        purchaseCost: 300,
        internalNotes: "Confidential sourcing note",
      }),
    );
    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct).not.toHaveProperty("sku");
    expect(publicProduct).not.toHaveProperty("purchaseCost");
    expect(publicProduct).not.toHaveProperty("internalNotes");
  });

  it("does not expose minOfferPrice on the public product", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        allowMakeOffer: true,
        minOfferPrice: 800,
      }),
    );
    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct).not.toHaveProperty("minOfferPrice");

    const listed = await listPublicProducts(db, { page: 1, pageSize: 20, sort: "newest" });
    for (const item of listed.items) {
      expect(item).not.toHaveProperty("minOfferPrice");
    }
  });

  it("exposes the Noctella Web long description instead of the canonical description", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        description: "Canonical description",
        wooShortDescription: "Approved Noctella Web short description",
        wooLongDescription: "Approved Noctella Web description",
      }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.shortDescription).toBe("Approved Noctella Web short description");
    expect(publicProduct.description).toBe("Approved Noctella Web description");
    expect(publicProduct).not.toHaveProperty("wooShortDescription");
    expect(publicProduct).not.toHaveProperty("wooLongDescription");
  });

  it("falls back to the canonical description when no Noctella Web long description exists", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        description: "Canonical fallback description",
      }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.shortDescription).toBeUndefined();
    expect(publicProduct.description).toBe("Canonical fallback description");
  });

  it("exposes Noctella Web SEO values instead of canonical SEO values", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        seoTitle: "Canonical SEO title",
        metaDescription: "Canonical meta description",
        wooSeoTitle: "Approved Noctella Web SEO title",
        wooMetaDescription: "Approved Noctella Web meta description",
      }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.seoTitle).toBe("Approved Noctella Web SEO title");
    expect(publicProduct.metaDescription).toBe("Approved Noctella Web meta description");
    expect(publicProduct).not.toHaveProperty("wooSeoTitle");
    expect(publicProduct).not.toHaveProperty("wooMetaDescription");
  });

  it("falls back to canonical SEO values when Noctella Web SEO values are absent", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        seoTitle: "Canonical fallback SEO title",
        metaDescription: "Canonical fallback meta description",
      }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.seoTitle).toBe("Canonical fallback SEO title");
    expect(publicProduct.metaDescription).toBe("Canonical fallback meta description");
  });

  it("leaves public SEO values undefined when Noctella Web and canonical SEO values are absent", async () => {
    const product = await createProduct(
      db,
      baseInput({ status: ProductStatus.Published }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.seoTitle).toBeUndefined();
    expect(publicProduct.metaDescription).toBeUndefined();
  });

  it("exposes the Noctella Web product name instead of the canonical title", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        title: "Canonical product title",
        wooProductName: "Approved Noctella Web product name",
      }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.title).toBe("Approved Noctella Web product name");
    expect(publicProduct).not.toHaveProperty("wooProductName");
  });

  it("falls back to the canonical title when no Noctella Web product name exists", async () => {
    const product = await createProduct(
      db,
      baseInput({
        status: ProductStatus.Published,
        title: "Canonical fallback title",
      }),
    );

    const publicProduct = await getPublicProductBySlug(db, product.slug);
    expect(publicProduct.title).toBe("Canonical fallback title");
  });

  it("exposes the Noctella Web listing price with canonical fallback", async () => {
    const wooPriced = await createProduct(
      db,
      baseInput({ title: "Woo-priced product", status: ProductStatus.Published, priceEur: 1200, wooListingPriceEur: 900 }),
    );
    const canonicalPriced = await createProduct(
      db,
      baseInput({ title: "Canonical-priced product", status: ProductStatus.Published, priceEur: 700 }),
    );

    const wooPublic = await getPublicProductBySlug(db, wooPriced.slug);
    const canonicalPublic = await getPublicProductBySlug(db, canonicalPriced.slug);
    expect(wooPublic.priceEur).toBe(900);
    expect(wooPublic).not.toHaveProperty("wooListingPriceEur");
    expect(canonicalPublic.priceEur).toBe(700);
  });

  it("filters by category slug", async () => {
    const otherCategory = await createCategory(db, { name: "Pens", displayOrder: 1, isActive: true });
    await createProduct(
      db,
      baseInput({ title: "Watch", status: ProductStatus.Published, categoryId }),
    );
    await createProduct(
      db,
      baseInput({ title: "Pen", status: ProductStatus.Published, categoryId: otherCategory.id }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      categorySlug: "watches",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Watch");
  });

  it("filters by collection slug", async () => {
    await createProduct(
      db,
      baseInput({ title: "In Collection", status: ProductStatus.Published, collectionId }),
    );
    await createProduct(db, baseInput({ title: "No Collection", status: ProductStatus.Published }));

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      collectionSlug: "gentleman-series",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("In Collection");
  });

  it("searches by title", async () => {
    await createProduct(
      db,
      baseInput({ title: "Art Deco Cigarette Case", status: ProductStatus.Published }),
    );
    await createProduct(db, baseInput({ title: "Fountain Pen", status: ProductStatus.Published }));

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      search: "Cigarette",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Art Deco Cigarette Case");
  });

  it("searches published products by Noctella Web product name", async () => {
    await createProduct(
      db,
      baseInput({
        title: "Canonical Published Name",
        wooProductName: "Noctella Aurora Timepiece",
        status: ProductStatus.Published,
      }),
    );
    await createProduct(
      db,
      baseInput({
        title: "Canonical Draft Name",
        wooProductName: "Noctella Aurora Draft",
        status: ProductStatus.Draft,
      }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      search: "aUrOrA",
    });

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.items[0].title).toBe("Noctella Aurora Timepiece");
    expect(result.items[0]).not.toHaveProperty("wooProductName");
  });

  it("sorts published products by the public Noctella Web title with canonical fallback", async () => {
    await createProduct(
      db,
      baseInput({
        title: "Alpha Canonical Name",
        wooProductName: "Zulu Display Name",
        status: ProductStatus.Published,
      }),
    );
    await createProduct(
      db,
      baseInput({
        title: "Zulu Canonical Name",
        wooProductName: "Alpha Display Name",
        status: ProductStatus.Published,
      }),
    );
    await createProduct(
      db,
      baseInput({ title: "Beta Fallback Name", status: ProductStatus.Published }),
    );
    await createProduct(
      db,
      baseInput({
        title: "Draft Canonical Name",
        wooProductName: "Aardvark Draft Name",
        status: ProductStatus.Draft,
      }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "title_asc",
    });

    expect(result.items.map((item) => item.title)).toEqual([
      "Alpha Display Name",
      "Beta Fallback Name",
      "Zulu Display Name",
    ]);
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.items.every((item) => !("wooProductName" in item))).toBe(true);
  });

  it("sorts ascending and descending by the effective Noctella Web price", async () => {
    await createProduct(db, baseInput({ title: "Canonical 10", status: ProductStatus.Published, priceEur: 10, wooListingPriceEur: 40 }));
    await createProduct(db, baseInput({ title: "Canonical 20", status: ProductStatus.Published, priceEur: 20, wooListingPriceEur: 5 }));
    await createProduct(db, baseInput({ title: "Canonical Fallback 30", status: ProductStatus.Published, priceEur: 30 }));

    const ascending = await listPublicProducts(db, { page: 1, pageSize: 20, sort: "price_asc" });
    const descending = await listPublicProducts(db, { page: 1, pageSize: 20, sort: "price_desc" });
    expect(ascending.items.map((item) => item.priceEur)).toEqual([5, 30, 40]);
    expect(descending.items.map((item) => item.priceEur)).toEqual([40, 30, 5]);
  });

  it("paginates results", async () => {
    for (let i = 0; i < 3; i++) {
      await createProduct(
        db,
        baseInput({ sku: `SKU-PAGE-${i}`, title: `Item ${i}`, status: ProductStatus.Published }),
      );
    }
    const page1 = await listPublicProducts(db, { page: 1, pageSize: 2, sort: "newest" });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await listPublicProducts(db, { page: 2, pageSize: 2, sort: "newest" });
    expect(page2.items).toHaveLength(1);
  });

  it("shows Sold products in the archive only when showInArchiveAfterSale is true", async () => {
    const soldVisible = await createProduct(
      db,
      baseInput({ title: "Sold Visible", status: ProductStatus.Draft, showInArchiveAfterSale: true }),
    );
    await updateProduct(db, soldVisible.id, { status: ProductStatus.Sold });

    const soldHidden = await createProduct(
      db,
      baseInput({ title: "Sold Hidden", status: ProductStatus.Draft, showInArchiveAfterSale: false }),
    );
    await updateProduct(db, soldHidden.id, { status: ProductStatus.Sold });

    const notSold = await createProduct(
      db,
      baseInput({ title: "Not Sold", status: ProductStatus.Published, showInArchiveAfterSale: true }),
    );
    void notSold;

    const archive = await listArchiveProducts(db, { page: 1, pageSize: 20 });
    expect(archive.items).toHaveLength(1);
    expect(archive.items[0].title).toBe("Sold Visible");
  });

  it("filters by isFeatured", async () => {
    await createProduct(
      db,
      baseInput({ title: "Featured Item", status: ProductStatus.Published, isFeatured: true }),
    );
    await createProduct(
      db,
      baseInput({ title: "Regular Item", status: ProductStatus.Published, isFeatured: false }),
    );

    const result = await listPublicProducts(db, {
      page: 1,
      pageSize: 20,
      sort: "newest",
      isFeatured: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Featured Item");
  });

  it("only lists active categories publicly", async () => {
    await createCategory(db, { name: "Inactive Category", displayOrder: 2, isActive: false });
    const publicCategories = await listPublicCategories(db);
    expect(publicCategories.some((c) => c.name === "Inactive Category")).toBe(false);
    expect(publicCategories.some((c) => c.name === "Watches")).toBe(true);
  });

  it("throws NotFoundError for an inactive category slug", async () => {
    const inactive = await createCategory(db, {
      name: "Hidden Category",
      displayOrder: 3,
      isActive: false,
    });
    await expect(getPublicCategoryBySlug(db, inactive.slug)).rejects.toBeInstanceOf(NotFoundError);
  });

  // Sprint 85: reproduces the RC2 acceptance defect end-to-end through the real product-write
  // use case and the public/Admin-list service functions, inserting a ProductPhoto row directly
  // (bypassing file storage) in the exact "Processing" state uploadProductPhoto leaves it in
  // before the hourly outbox promotion sweep runs. Before the fix, this returned photos: [],
  // images: [], and an empty Admin list thumbnail; ProductPhoto/product_photos is the only photo
  // source involved - no legacy productImages row exists for this product.
  it("returns a Processing Primary photo on public detail, public list, and Admin list (RC2 acceptance regression)", async () => {
    const product = await createProduct(
      db,
      baseInput({ title: "Gamma Vase", status: ProductStatus.Published }),
    );
    const now = new Date().toISOString();
    await db.insert(schema.productPhotos).values({
      id: "ph-rc2",
      productId: product.id,
      url: "/images/product-photos/gamma.webp",
      thumbnailUrl: "/images/product-photos/gamma-thumb.webp",
      altText: "gamma vase",
      sortOrder: 0,
      isPrimary: true,
      filename: "gamma.webp",
      mimeType: "image/webp",
      sizeBytes: 12345,
      width: 1500,
      height: 2000,
      processingStatus: "Processing",
      createdAt: now,
      updatedAt: now,
    } as any);

    const detail = await getPublicProductBySlug(db, product.slug);
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0]).toMatchObject({ id: "ph-rc2", isPrimary: true, url: "/images/product-photos/gamma.webp" });
    expect(detail.images).toHaveLength(1);

    const list = await listPublicProducts(db, { page: 1, pageSize: 20, sort: "newest" });
    const listedGamma = list.items.find((item) => item.id === product.id);
    expect(listedGamma?.photos.map((p) => p.id)).toEqual(["ph-rc2"]);

    const adminList = await listProducts(db, { page: 1, pageSize: 20 } as any);
    const adminListedGamma = adminList.items.find((item: any) => item.id === product.id);
    expect(adminListedGamma?.primaryImageUrl).toBe("/images/product-photos/gamma.webp");
  });
});
