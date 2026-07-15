import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import {
  type Product,
  type ProductImage,
  type ProductPhoto,
  type ProductMarketplaceReadiness,
  ProductStatus,
  ProductType,
} from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories, collections, outboxEvents, productImages, productPhotos, products } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import type { PhotoStorage, StoredProductPhoto } from "./photoStorage";
import { photoStorage } from "./photoStorage";
import { OutboxEventStatus, OutboxEventType } from "./outbox";
import { slugify } from "../validation/common";
import type { CreateProductInput, ProductListQuery, UpdateProductInput } from "../validation/product";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import type { ProductReadServiceContext } from "../repositories/product-read/types";

function toProduct(row: typeof products.$inferSelect): Product {
  return {
    id: row.id,
    erpReferenceId: row.erpReferenceId ?? undefined,
    sku: row.sku,
    title: row.title,
    slug: row.slug,
    type: row.type as ProductType,
    status: row.status as ProductStatus,
    categoryId: row.categoryId ?? undefined,
    collectionId: row.collectionId ?? undefined,
    brand: row.brand ?? undefined,
    model: row.model ?? undefined,
    manufacturer: row.manufacturer ?? undefined,
    countryOfOrigin: row.countryOfOrigin ?? undefined,
    period: row.period ?? undefined,
    materials: row.materials ?? undefined,
    description: row.description ?? undefined,
    productStory: row.productStory ?? undefined,
    condition: row.condition ?? undefined,
    conditionDescription: row.conditionDescription ?? undefined,
    lengthValue: row.lengthValue ?? undefined,
    widthValue: row.widthValue ?? undefined,
    heightValue: row.heightValue ?? undefined,
    dimensionUnit: (row.dimensionUnit as Product["dimensionUnit"]) ?? undefined,
    weightValue: row.weightValue ?? undefined,
    weightUnit: (row.weightUnit as Product["weightUnit"]) ?? undefined,
    stockQuantity: row.stockQuantity,
    lotItemCount: row.lotItemCount ?? undefined,
    purchaseCost: row.purchaseCost ?? undefined,
    purchaseCurrency: (row.purchaseCurrency as Product["purchaseCurrency"]) ?? undefined,
    internalNotes: row.internalNotes ?? undefined,
    priceEur: row.priceEur,
    priceUsd: row.priceUsd ?? undefined,
    minOfferPrice: row.minOfferPrice ?? undefined,
    videoUrl: row.videoUrl ?? undefined,
    shippingProfile: row.shippingProfile ?? undefined,
    shippingNote: row.shippingNote ?? undefined,
    customsWarning: row.customsWarning,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
    keywords: row.keywords ? (JSON.parse(row.keywords) as string[]) : undefined,
    isFeatured: row.isFeatured,
    allowMakeOffer: row.allowMakeOffer,
    allowCashOnDelivery: row.allowCashOnDelivery,
    showInArchiveAfterSale: row.showInArchiveAfterSale,
    ebayTitle: row.ebayTitle ?? undefined,
    ebaySubtitle: row.ebaySubtitle ?? undefined,
    ebayDescription: row.ebayDescription ?? undefined,
    ebayConditionDescription: row.ebayConditionDescription ?? undefined,
    ebayCategory: row.ebayCategory ?? undefined,
    ebayItemSpecifics: row.ebayItemSpecifics ?? undefined,
    ebayListingPriceEur: row.ebayListingPriceEur ?? undefined,
    ebayListingStatus: (row.ebayListingStatus as Product["ebayListingStatus"]) ?? undefined,
    etsyTitle: row.etsyTitle ?? undefined,
    etsyDescription: row.etsyDescription ?? undefined,
    etsyTags: row.etsyTags ? (JSON.parse(row.etsyTags) as string[]) : undefined,
    etsyMaterials: row.etsyMaterials ?? undefined,
    etsyStyle: row.etsyStyle ?? undefined,
    etsyOccasion: row.etsyOccasion ?? undefined,
    etsyListingPriceEur: row.etsyListingPriceEur ?? undefined,
    etsyListingStatus: (row.etsyListingStatus as Product["etsyListingStatus"]) ?? undefined,
    wooProductName: row.wooProductName ?? undefined,
    wooShortDescription: row.wooShortDescription ?? undefined,
    wooLongDescription: row.wooLongDescription ?? undefined,
    wooSlug: row.wooSlug ?? undefined,
    wooSeoTitle: row.wooSeoTitle ?? undefined,
    wooMetaDescription: row.wooMetaDescription ?? undefined,
    wooFocusKeyword: row.wooFocusKeyword ?? undefined,
    wooListingPriceEur: row.wooListingPriceEur ?? undefined,
    wooListingStatus: (row.wooListingStatus as Product["wooListingStatus"]) ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}


function toProductPhoto(row: typeof productPhotos.$inferSelect): ProductPhoto {
  return {
    id: row.id,
    productId: row.productId,
    url: row.url,
    thumbnailUrl: row.thumbnailUrl,
    altText: row.altText ?? undefined,
    sortOrder: row.sortOrder,
    isPrimary: row.isPrimary,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    processingStatus: (row.processingStatus as ProductPhoto["processingStatus"]) ?? "Ready",
    storageKey: row.storageKey,
    thumbnailStorageKey: row.thumbnailStorageKey,
    processingErrorCode: row.processingErrorCode,
    processingUpdatedAt: row.processingUpdatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProductImage(row: typeof productImages.$inferSelect): ProductImage {
  return {
    id: row.id,
    productId: row.productId,
    url: row.url,
    altText: row.altText ?? undefined,
    sortOrder: row.sortOrder,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertSkuAvailable(db: DbClient, sku: string, excludeId?: string): Promise<void> {
  const rows = await db.select({ id: products.id }).from(products).where(eq(products.sku, sku));
  const conflict = rows.find((row) => row.id !== excludeId);
  if (conflict) {
    throw new ConflictError(`SKU "${sku}" is already in use`);
  }
}

async function assertSlugAvailable(db: DbClient, slug: string, excludeId?: string): Promise<void> {
  const rows = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
  const conflict = rows.find((row) => row.id !== excludeId);
  if (conflict) {
    throw new ConflictError(`Product slug "${slug}" is already in use`);
  }
}

async function assertCategoryExists(db: DbClient, categoryId: string): Promise<void> {
  const [row] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
  if (!row) {
    throw new BadRequestError(`Category "${categoryId}" does not exist`);
  }
}

async function assertCollectionExists(db: DbClient, collectionId: string): Promise<void> {
  const [row] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, collectionId));
  if (!row) {
    throw new BadRequestError(`Collection "${collectionId}" does not exist`);
  }
}

/**
 * Applies Sprint 2 stock rules (spec §2):
 * - Unique Item: defaults to 1, cannot exceed 1.
 * - Lot Item: defaults to 1 (the listing itself), lotItemCount is informational only.
 */
function resolveStockQuantity(type: ProductType, requested: number | undefined): number {
  if (type === ProductType.UniqueItem) {
    const qty = requested ?? 1;
    if (qty > 1) {
      throw new BadRequestError("Unique Item stock quantity cannot exceed 1");
    }
    return qty;
  }
  // Lot Item
  return requested ?? 1;
}

async function replaceImages(
  db: DbClient,
  productId: string,
  images: CreateProductInput["images"],
): Promise<void> {
  await db.delete(productImages).where(eq(productImages.productId, productId));
  if (!images || images.length === 0) return;

  const primaryCount = images.filter((img) => img.isPrimary).length;
  if (primaryCount > 1) {
    throw new BadRequestError("Only one primary image is allowed");
  }

  const now = new Date().toISOString();
  for (const image of images) {
    await db.insert(productImages).values({
      id: randomUUID(),
      productId,
      url: image.url,
      altText: image.altText,
      sortOrder: image.sortOrder,
      isPrimary: image.isPrimary,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function getImagesForProduct(db: DbClient, productId: string): Promise<ProductImage[]> {
  const rows = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, productId))
    .orderBy(asc(productImages.sortOrder));
  return rows.map(toProductImage);
}


async function getPhotosForProduct(db: DbClient, productId: string): Promise<ProductPhoto[]> {
  const rows = await db
    .select()
    .from(productPhotos)
    .where(eq(productPhotos.productId, productId))
    .orderBy(asc(productPhotos.sortOrder));
  return rows.map(toProductPhoto);
}

async function ensureSinglePrimary(db: DbClient, productId: string, primaryId?: string): Promise<void> {
  const photos = await getPhotosForProduct(db, productId);
  const selected = primaryId ?? photos.find((photo) => photo.isPrimary)?.id ?? photos[0]?.id;
  if (!selected) return;
  const now = new Date().toISOString();
  for (const photo of photos) {
    await db.update(productPhotos).set({ isPrimary: photo.id === selected, updatedAt: now }).where(eq(productPhotos.id, photo.id));
  }
}

function photoToLegacyImage(photo: ProductPhoto): ProductImage {
  return {
    id: photo.id,
    productId: photo.productId,
    url: photo.url,
    altText: photo.altText,
    sortOrder: photo.sortOrder,
    isPrimary: photo.isPrimary,
    createdAt: photo.createdAt,
    updatedAt: photo.updatedAt,
  };
}

async function getPreferredImagesForProduct(db: DbClient, productId: string): Promise<ProductImage[]> {
  const photos = await getPhotosForProduct(db, productId);
  if (photos.length > 0) return photos.map(photoToLegacyImage);
  return getImagesForProduct(db, productId);
}
export interface ProductWithImages extends Product {
  photos: ProductPhoto[];
  images: ProductImage[];
  marketplaceReadiness: ProductMarketplaceReadiness;
}

/**
 * Sprint 3: computes which fields are missing for each marketplace, without
 * blocking product save. Required-field sets below are a minimal, sensible
 * foundation (title/description/category/price per platform) — full
 * platform-specific publish validation is out of scope for this sprint.
 */
export function computeMarketplaceReadiness(product: Product): ProductMarketplaceReadiness {
  const missing = (fields: Array<[string, unknown]>) =>
    fields.filter(([, value]) => value === undefined || value === null || value === "").map(([name]) => name);

  const ebayMissing = missing([
    ["title", product.ebayTitle],
    ["description", product.ebayDescription],
    ["category", product.ebayCategory],
    ["listingPriceEur", product.ebayListingPriceEur],
  ]);

  const etsyMissing = missing([
    ["title", product.etsyTitle],
    ["description", product.etsyDescription],
    ["listingPriceEur", product.etsyListingPriceEur],
  ]);

  const wooMissing = missing([
    ["productName", product.wooProductName],
    ["shortDescription", product.wooShortDescription],
    ["listingPriceEur", product.wooListingPriceEur],
  ]);

  return {
    ebay: { ready: ebayMissing.length === 0, missingFields: ebayMissing },
    etsy: { ready: etsyMissing.length === 0, missingFields: etsyMissing },
    woocommerce: { ready: wooMissing.length === 0, missingFields: wooMissing },
  };
}

export async function listProducts(db: DbClient, query: ProductListQuery, context?: ProductReadServiceContext) {
  context ??= createProductReadServiceContextForDb(db);
  const rows = await context.repositories.products.list(query);
  const total = await context.repositories.products.count(query);
  const items = await Promise.all(rows.map(async (row: any) => {
    const product = toProduct(row);
    const images = await context.repositories.photos.listLegacyCompatibleByProduct(row.id);
    const primaryImage = images.find((img: any) => img.isPrimary) ?? images[0];
    return { ...product, primaryImageUrl: primaryImage?.url };
  }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getProductById(db: DbClient, id: string, context?: ProductReadServiceContext): Promise<ProductWithImages> {
  context ??= createProductReadServiceContextForDb(db);
  const row = await context.repositories.products.getById(id);
  if (!row) throw new NotFoundError("Product not found");
  const photos = (await context.repositories.photos.listAdminByProduct(id)).map(toProductPhoto);
  const legacy = await context.repositories.photos.listLegacyCompatibleByProduct(id);
  const images = legacy.map((img: any) => "filename" in img ? photoToLegacyImage(toProductPhoto(img)) : toProductImage(img));
  const product = toProduct(row);
  return { ...product, photos, images, marketplaceReadiness: computeMarketplaceReadiness(product) };
}

export async function createProduct(
  db: DbClient,
  input: CreateProductInput,
): Promise<ProductWithImages> {
  await assertSkuAvailable(db, input.sku);
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  await assertSlugAvailable(db, slug);
  await assertCategoryExists(db, input.categoryId);
  if (input.collectionId) {
    await assertCollectionExists(db, input.collectionId);
  }

  const stockQuantity = resolveStockQuantity(input.type, input.stockQuantity);

  const now = new Date().toISOString();
  const id = randomUUID();

  await db.insert(products).values({
    id,
    sku: input.sku,
    title: input.title,
    slug,
    type: input.type,
    status: input.status,
    categoryId: input.categoryId,
    collectionId: input.collectionId,
    brand: input.brand,
    model: input.model,
    manufacturer: input.manufacturer,
    countryOfOrigin: input.countryOfOrigin,
    period: input.period,
    materials: input.materials,
    description: input.description,
    productStory: input.productStory,
    condition: input.condition,
    conditionDescription: input.conditionDescription,
    lengthValue: input.lengthValue,
    widthValue: input.widthValue,
    heightValue: input.heightValue,
    dimensionUnit: input.dimensionUnit,
    weightValue: input.weightValue,
    weightUnit: input.weightUnit,
    stockQuantity,
    lotItemCount: input.lotItemCount,
    purchaseCost: input.purchaseCost,
    purchaseCurrency: input.purchaseCurrency,
    internalNotes: input.internalNotes,
    priceEur: input.priceEur,
    priceUsd: input.priceUsd,
    minOfferPrice: input.minOfferPrice,
    videoUrl: input.videoUrl,
    shippingProfile: input.shippingProfile,
    shippingNote: input.shippingNote,
    customsWarning: input.customsWarning,
    seoTitle: input.seoTitle,
    metaDescription: input.metaDescription,
    keywords: input.keywords ? JSON.stringify(input.keywords) : undefined,
    isFeatured: input.isFeatured,
    allowMakeOffer: input.allowMakeOffer,
    allowCashOnDelivery: input.allowCashOnDelivery,
    showInArchiveAfterSale: input.showInArchiveAfterSale,
    ebayTitle: input.ebayTitle,
    ebaySubtitle: input.ebaySubtitle,
    ebayDescription: input.ebayDescription,
    ebayConditionDescription: input.ebayConditionDescription,
    ebayCategory: input.ebayCategory,
    ebayItemSpecifics: input.ebayItemSpecifics,
    ebayListingPriceEur: input.ebayListingPriceEur,
    ebayListingStatus: input.ebayListingStatus,
    etsyTitle: input.etsyTitle,
    etsyDescription: input.etsyDescription,
    etsyTags: input.etsyTags ? JSON.stringify(input.etsyTags) : undefined,
    etsyMaterials: input.etsyMaterials,
    etsyStyle: input.etsyStyle,
    etsyOccasion: input.etsyOccasion,
    etsyListingPriceEur: input.etsyListingPriceEur,
    etsyListingStatus: input.etsyListingStatus,
    wooProductName: input.wooProductName,
    wooShortDescription: input.wooShortDescription,
    wooLongDescription: input.wooLongDescription,
    wooSlug: input.wooSlug,
    wooSeoTitle: input.wooSeoTitle,
    wooMetaDescription: input.wooMetaDescription,
    wooFocusKeyword: input.wooFocusKeyword,
    wooListingPriceEur: input.wooListingPriceEur,
    wooListingStatus: input.wooListingStatus,
    createdAt: now,
    updatedAt: now,
  });

  if (input.images) {
    await replaceImages(db, id, input.images);
  }

  return getProductById(db, id);
}

export async function updateProduct(
  db: DbClient,
  id: string,
  input: UpdateProductInput,
): Promise<ProductWithImages> {
  const existing = await getProductById(db, id);

  if (input.sku !== undefined) {
    await assertSkuAvailable(db, input.sku, id);
  }
  let slug: string | undefined;
  if (input.slug !== undefined) {
    slug = slugify(input.slug);
    await assertSlugAvailable(db, slug, id);
  }
  if (input.categoryId !== undefined) {
    await assertCategoryExists(db, input.categoryId);
  }
  if (input.collectionId !== undefined) {
    await assertCollectionExists(db, input.collectionId);
  }

  const effectiveType = input.type ?? existing.type;
  let stockQuantity: number | undefined;
  if (input.stockQuantity !== undefined || input.type !== undefined) {
    stockQuantity = resolveStockQuantity(
      effectiveType,
      input.stockQuantity !== undefined ? input.stockQuantity : existing.stockQuantity,
    );
  }

  await db
    .update(products)
    .set({
      ...(input.sku !== undefined ? { sku: input.sku } : {}),
      ...(slug !== undefined ? { slug } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      ...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
      ...(input.brand !== undefined ? { brand: input.brand } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.manufacturer !== undefined ? { manufacturer: input.manufacturer } : {}),
      ...(input.countryOfOrigin !== undefined ? { countryOfOrigin: input.countryOfOrigin } : {}),
      ...(input.period !== undefined ? { period: input.period } : {}),
      ...(input.materials !== undefined ? { materials: input.materials } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.productStory !== undefined ? { productStory: input.productStory } : {}),
      ...(input.condition !== undefined ? { condition: input.condition } : {}),
      ...(input.conditionDescription !== undefined
        ? { conditionDescription: input.conditionDescription }
        : {}),
      ...(input.lengthValue !== undefined ? { lengthValue: input.lengthValue } : {}),
      ...(input.widthValue !== undefined ? { widthValue: input.widthValue } : {}),
      ...(input.heightValue !== undefined ? { heightValue: input.heightValue } : {}),
      ...(input.dimensionUnit !== undefined ? { dimensionUnit: input.dimensionUnit } : {}),
      ...(input.weightValue !== undefined ? { weightValue: input.weightValue } : {}),
      ...(input.weightUnit !== undefined ? { weightUnit: input.weightUnit } : {}),
      ...(stockQuantity !== undefined ? { stockQuantity } : {}),
      ...(input.lotItemCount !== undefined ? { lotItemCount: input.lotItemCount } : {}),
      ...(input.purchaseCost !== undefined ? { purchaseCost: input.purchaseCost } : {}),
      ...(input.purchaseCurrency !== undefined ? { purchaseCurrency: input.purchaseCurrency } : {}),
      ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes } : {}),
      ...(input.priceEur !== undefined ? { priceEur: input.priceEur } : {}),
      ...(input.priceUsd !== undefined ? { priceUsd: input.priceUsd } : {}),
      ...(input.minOfferPrice !== undefined ? { minOfferPrice: input.minOfferPrice } : {}),
      ...(input.videoUrl !== undefined ? { videoUrl: input.videoUrl } : {}),
      ...(input.shippingProfile !== undefined ? { shippingProfile: input.shippingProfile } : {}),
      ...(input.shippingNote !== undefined ? { shippingNote: input.shippingNote } : {}),
      ...(input.customsWarning !== undefined ? { customsWarning: input.customsWarning } : {}),
      ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.keywords !== undefined ? { keywords: JSON.stringify(input.keywords) } : {}),
      ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
      ...(input.allowMakeOffer !== undefined ? { allowMakeOffer: input.allowMakeOffer } : {}),
      ...(input.allowCashOnDelivery !== undefined
        ? { allowCashOnDelivery: input.allowCashOnDelivery }
        : {}),
      ...(input.showInArchiveAfterSale !== undefined
        ? { showInArchiveAfterSale: input.showInArchiveAfterSale }
        : {}),
      ...(input.ebayTitle !== undefined ? { ebayTitle: input.ebayTitle } : {}),
      ...(input.ebaySubtitle !== undefined ? { ebaySubtitle: input.ebaySubtitle } : {}),
      ...(input.ebayDescription !== undefined ? { ebayDescription: input.ebayDescription } : {}),
      ...(input.ebayConditionDescription !== undefined
        ? { ebayConditionDescription: input.ebayConditionDescription }
        : {}),
      ...(input.ebayCategory !== undefined ? { ebayCategory: input.ebayCategory } : {}),
      ...(input.ebayItemSpecifics !== undefined ? { ebayItemSpecifics: input.ebayItemSpecifics } : {}),
      ...(input.ebayListingPriceEur !== undefined
        ? { ebayListingPriceEur: input.ebayListingPriceEur }
        : {}),
      ...(input.ebayListingStatus !== undefined ? { ebayListingStatus: input.ebayListingStatus } : {}),
      ...(input.etsyTitle !== undefined ? { etsyTitle: input.etsyTitle } : {}),
      ...(input.etsyDescription !== undefined ? { etsyDescription: input.etsyDescription } : {}),
      ...(input.etsyTags !== undefined ? { etsyTags: JSON.stringify(input.etsyTags) } : {}),
      ...(input.etsyMaterials !== undefined ? { etsyMaterials: input.etsyMaterials } : {}),
      ...(input.etsyStyle !== undefined ? { etsyStyle: input.etsyStyle } : {}),
      ...(input.etsyOccasion !== undefined ? { etsyOccasion: input.etsyOccasion } : {}),
      ...(input.etsyListingPriceEur !== undefined
        ? { etsyListingPriceEur: input.etsyListingPriceEur }
        : {}),
      ...(input.etsyListingStatus !== undefined ? { etsyListingStatus: input.etsyListingStatus } : {}),
      ...(input.wooProductName !== undefined ? { wooProductName: input.wooProductName } : {}),
      ...(input.wooShortDescription !== undefined
        ? { wooShortDescription: input.wooShortDescription }
        : {}),
      ...(input.wooLongDescription !== undefined
        ? { wooLongDescription: input.wooLongDescription }
        : {}),
      ...(input.wooSlug !== undefined ? { wooSlug: input.wooSlug } : {}),
      ...(input.wooSeoTitle !== undefined ? { wooSeoTitle: input.wooSeoTitle } : {}),
      ...(input.wooMetaDescription !== undefined
        ? { wooMetaDescription: input.wooMetaDescription }
        : {}),
      ...(input.wooFocusKeyword !== undefined ? { wooFocusKeyword: input.wooFocusKeyword } : {}),
      ...(input.wooListingPriceEur !== undefined
        ? { wooListingPriceEur: input.wooListingPriceEur }
        : {}),
      ...(input.wooListingStatus !== undefined ? { wooListingStatus: input.wooListingStatus } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(products.id, id));

  if (input.images !== undefined) {
    await replaceImages(db, id, input.images);
  }

  return getProductById(db, id);
}

/** Archive only — Sprint 2 explicitly forbids permanent deletion. */
export async function archiveProduct(db: DbClient, id: string): Promise<ProductWithImages> {
  await getProductById(db, id);
  await db
    .update(products)
    .set({ status: ProductStatus.Archived, updatedAt: new Date().toISOString() })
    .where(eq(products.id, id));
  return getProductById(db, id);
}


export async function uploadProductPhoto(
  db: DbClient,
  productId: string,
  file: { buffer: Buffer; mimetype: string; size: number },
  altText?: string,
  storage: PhotoStorage = photoStorage,
): Promise<ProductPhoto> {
  await getProductById(db, productId);
  const stored = await storage.saveProductPhoto(file);
  const existing = await getPhotosForProduct(db, productId);
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    const values = {
      id,
      productId,
      url: stored.url,
      thumbnailUrl: stored.thumbnailUrl,
      altText,
      sortOrder: existing.length,
      isPrimary: existing.length === 0,
      filename: stored.filename,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      width: stored.width,
      height: stored.height,
      processingStatus: "Processing",
      storageKey: stored.filename,
      thumbnailStorageKey: `${stored.filename}-thumb`,
      processingUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const eventValues = { id: randomUUID(), eventType: OutboxEventType.ProductPhotoPromoteRequested, aggregateType: "ProductPhoto", aggregateId: id, idempotencyKey: `product-photo-promote:${id}`, payload: JSON.stringify({ photoId: id, productId }), status: OutboxEventStatus.Pending, attemptCount: 0, maxAttempts: 3, availableAt: now, createdAt: now, updatedAt: now };
    const runSync = (tx: DbClient) => {
      (tx.insert(productPhotos).values(values) as unknown as { run(): void }).run();
      (tx.insert(outboxEvents).values(eventValues) as unknown as { run(): void }).run();
    };
    const runAsync = async (tx: DbClient) => {
      await tx.insert(productPhotos).values(values);
      await tx.insert(outboxEvents).values(eventValues);
    };
    if (typeof (db as DbClient & { transaction?: unknown }).transaction === "function" && !Object.prototype.hasOwnProperty.call(db, "insert")) {
      (db as DbClient & { transaction: (work: (tx: DbClient) => void) => void }).transaction(runSync);
    } else {
      await runAsync(db);
    }
    await ensureSinglePrimary(db, productId);
    return (await getPhotosForProduct(db, productId)).find((photo) => photo.id === id)!;
  } catch (err) {
    await storage.deleteProductPhoto({ url: stored.url, thumbnailUrl: stored.thumbnailUrl });
    throw err;
  }
}

export async function updateProductPhoto(db: DbClient, productId: string, photoId: string, altText?: string): Promise<ProductPhoto> {
  await getProductById(db, productId);
  const [photo] = await db.select().from(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId)));
  if (!photo) throw new NotFoundError("Product photo not found");
  await db.update(productPhotos).set({ altText, updatedAt: new Date().toISOString() }).where(eq(productPhotos.id, photoId));
  return (await getPhotosForProduct(db, productId)).find((item) => item.id === photoId)!;
}

export async function setPrimaryProductPhoto(db: DbClient, productId: string, photoId: string): Promise<ProductPhoto[]> {
  await getProductById(db, productId);
  const [photo] = await db.select().from(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId)));
  if (!photo) throw new NotFoundError("Product photo not found");
  await ensureSinglePrimary(db, productId, photoId);
  return getPhotosForProduct(db, productId);
}

export async function reorderProductPhotos(db: DbClient, productId: string, photoIds: string[]): Promise<ProductPhoto[]> {
  await getProductById(db, productId);
  const photos = await getPhotosForProduct(db, productId);
  if (photos.length !== photoIds.length || photos.some((photo) => !photoIds.includes(photo.id))) {
    throw new BadRequestError("Reorder payload must include every product photo exactly once");
  }
  const now = new Date().toISOString();
  for (const [sortOrder, photoId] of photoIds.entries()) {
    await db.update(productPhotos).set({ sortOrder, updatedAt: now }).where(eq(productPhotos.id, photoId));
  }
  return getPhotosForProduct(db, productId);
}

export async function deleteProductPhoto(
  db: DbClient,
  productId: string,
  photoId: string,
  storage: PhotoStorage = photoStorage,
): Promise<ProductPhoto[]> {
  await getProductById(db, productId);
  const [photo] = await db.select().from(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId)));
  if (!photo) throw new NotFoundError("Product photo not found");
  await db.delete(productPhotos).where(eq(productPhotos.id, photoId));
  await db.insert(outboxEvents).values({ id: randomUUID(), eventType: OutboxEventType.ProductPhotoDeleteRequested, aggregateType: "ProductPhoto", aggregateId: photoId, idempotencyKey: `product-photo-delete:${photoId}`, payload: JSON.stringify({ photoId, productId }), status: OutboxEventStatus.Pending, attemptCount: 0, maxAttempts: 3, availableAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await storage.deleteProductPhoto({ url: photo.url, thumbnailUrl: photo.thumbnailUrl });
  const remaining = await getPhotosForProduct(db, productId);
  for (const [sortOrder, item] of remaining.entries()) {
    await db.update(productPhotos).set({ sortOrder }).where(eq(productPhotos.id, item.id));
  }
  await ensureSinglePrimary(db, productId);
  return getPhotosForProduct(db, productId);
}
