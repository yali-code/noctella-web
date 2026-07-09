import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { type Product, type ProductImage, ProductStatus, ProductType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories, collections, productImages, products } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { slugify } from "../validation/common";
import type { CreateProductInput, ProductListQuery, UpdateProductInput } from "../validation/product";

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

export interface ProductWithImages extends Product {
  images: ProductImage[];
}

export async function listProducts(db: DbClient, query: ProductListQuery) {
  const conditions = [];
  if (query.search) {
    conditions.push(
      or(like(products.title, `%${query.search}%`), like(products.sku, `%${query.search}%`)),
    );
  }
  if (query.status) conditions.push(eq(products.status, query.status));
  if (query.type) conditions.push(eq(products.type, query.type));
  if (query.categoryId) conditions.push(eq(products.categoryId, query.categoryId));
  if (query.collectionId) conditions.push(eq(products.collectionId, query.collectionId));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(products)
    .where(whereClause);

  const rows = await db
    .select()
    .from(products)
    .where(whereClause)
    .orderBy(desc(products.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const items = await Promise.all(
    rows.map(async (row) => {
      const product = toProduct(row);
      const primaryImage = (await getImagesForProduct(db, row.id)).find((img) => img.isPrimary);
      return { ...product, primaryImageUrl: primaryImage?.url };
    }),
  );

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getProductById(db: DbClient, id: string): Promise<ProductWithImages> {
  const [row] = await db.select().from(products).where(eq(products.id, id));
  if (!row) throw new NotFoundError("Product not found");
  const images = await getImagesForProduct(db, id);
  return { ...toProduct(row), images };
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
