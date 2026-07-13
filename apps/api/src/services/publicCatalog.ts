import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories, collections, productImages, productPhotos, products } from "../db/schema";
import { NotFoundError } from "./errors";
import type { PublicProductListQuery } from "../validation/publicCatalog";

/**
 * Customer-safe product shape. Deliberately excludes internal/ERP-only
 * fields: sku, purchaseCost, purchaseCurrency, internalNotes,
 * erpReferenceId, and all eBay/Etsy/WooCommerce marketplace fields.
 */
export interface PublicProduct {
  id: string;
  slug: string;
  title: string;
  type: ProductType;
  description?: string;
  productStory?: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
  countryOfOrigin?: string;
  period?: string;
  materials?: string;
  lengthValue?: number;
  widthValue?: number;
  heightValue?: number;
  dimensionUnit?: string;
  weightValue?: number;
  weightUnit?: string;
  condition?: string;
  conditionDescription?: string;
  priceEur: number;
  priceUsd?: number;
  videoUrl?: string;
  shippingNote?: string;
  customsWarning: boolean;
  isFeatured: boolean;
  allowMakeOffer: boolean;
  allowCashOnDelivery: boolean;
  status: ProductStatus;
  categoryId?: string;
  categoryName?: string;
  categorySlug?: string;
  collectionId?: string;
  collectionName?: string;
  collectionSlug?: string;
  seoTitle?: string;
  metaDescription?: string;
  photos: Array<{ id: string; url: string; thumbnailUrl?: string; altText?: string; sortOrder: number; isPrimary: boolean }>;
  images: Array<{ id: string; url: string; thumbnailUrl?: string; altText?: string; sortOrder: number; isPrimary: boolean }>;
  createdAt: string;
  updatedAt: string;
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  displayImageUrl?: string;
  seoTitle?: string;
  metaDescription?: string;
}

export interface PublicCollection {
  id: string;
  name: string;
  slug: string;
  description?: string;
  coverImageUrl?: string;
  seoTitle?: string;
  metaDescription?: string;
}

function toPublicCategory(row: typeof categories.$inferSelect): PublicCategory {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    displayImageUrl: row.displayImageUrl ?? undefined,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
  };
}

function toPublicCollection(row: typeof collections.$inferSelect): PublicCollection {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
    coverImageUrl: row.coverImageUrl ?? undefined,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
  };
}

async function toPublicProduct(
  db: DbClient,
  row: typeof products.$inferSelect,
): Promise<PublicProduct> {
  const photos = await db
    .select()
    .from(productPhotos)
    .where(eq(productPhotos.productId, row.id))
    .orderBy(asc(productPhotos.sortOrder));
  const images = photos.length > 0
    ? photos.map((photo) => ({ id: photo.id, url: photo.url, thumbnailUrl: photo.thumbnailUrl, altText: photo.altText, sortOrder: photo.sortOrder, isPrimary: photo.isPrimary }))
    : await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, row.id))
      .orderBy(asc(productImages.sortOrder));

  let categoryName: string | undefined;
  let categorySlug: string | undefined;
  if (row.categoryId) {
    const [cat] = await db.select().from(categories).where(eq(categories.id, row.categoryId));
    categoryName = cat?.name;
    categorySlug = cat?.slug;
  }

  let collectionName: string | undefined;
  let collectionSlug: string | undefined;
  if (row.collectionId) {
    const [col] = await db.select().from(collections).where(eq(collections.id, row.collectionId));
    collectionName = col?.name;
    collectionSlug = col?.slug;
  }

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type as ProductType,
    description: row.description ?? undefined,
    productStory: row.productStory ?? undefined,
    brand: row.brand ?? undefined,
    model: row.model ?? undefined,
    manufacturer: row.manufacturer ?? undefined,
    countryOfOrigin: row.countryOfOrigin ?? undefined,
    period: row.period ?? undefined,
    materials: row.materials ?? undefined,
    lengthValue: row.lengthValue ?? undefined,
    widthValue: row.widthValue ?? undefined,
    heightValue: row.heightValue ?? undefined,
    dimensionUnit: row.dimensionUnit ?? undefined,
    weightValue: row.weightValue ?? undefined,
    weightUnit: row.weightUnit ?? undefined,
    condition: row.condition ?? undefined,
    conditionDescription: row.conditionDescription ?? undefined,
    priceEur: row.priceEur,
    priceUsd: row.priceUsd ?? undefined,
    videoUrl: row.videoUrl ?? undefined,
    shippingNote: row.shippingNote ?? undefined,
    customsWarning: row.customsWarning,
    isFeatured: row.isFeatured,
    allowMakeOffer: row.allowMakeOffer,
    allowCashOnDelivery: row.allowCashOnDelivery,
    status: row.status as ProductStatus,
    categoryId: row.categoryId ?? undefined,
    categoryName,
    categorySlug,
    collectionId: row.collectionId ?? undefined,
    collectionName,
    collectionSlug,
    seoTitle: row.seoTitle ?? undefined,
    metaDescription: row.metaDescription ?? undefined,
    photos: photos.map((photo) => ({
      id: photo.id,
      url: photo.url,
      thumbnailUrl: photo.thumbnailUrl,
      altText: photo.altText ?? undefined,
      sortOrder: photo.sortOrder,
      isPrimary: photo.isPrimary,
    })),
    images: images.map((img) => ({
      id: img.id,
      url: img.url,
      thumbnailUrl: "thumbnailUrl" in img ? img.thumbnailUrl ?? undefined : undefined,
      altText: img.altText ?? undefined,
      sortOrder: img.sortOrder,
      isPrimary: img.isPrimary,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listPublicProducts(db: DbClient, query: PublicProductListQuery) {
  const conditions = [eq(products.status, ProductStatus.Published)];

  if (query.search) {
    conditions.push(
      or(like(products.title, `%${query.search}%`), like(products.description, `%${query.search}%`))!,
    );
  }
  if (query.categorySlug) {
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, query.categorySlug));
    // No matching category -> force an empty result rather than ignoring the filter.
    conditions.push(eq(products.categoryId, category?.id ?? "__no_match__"));
  }
  if (query.collectionSlug) {
    const [collection] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.slug, query.collectionSlug));
    conditions.push(eq(products.collectionId, collection?.id ?? "__no_match__"));
  }
  if (query.isFeatured !== undefined) {
    conditions.push(eq(products.isFeatured, query.isFeatured));
  }

  const whereClause = and(...conditions);

  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(products).where(whereClause);

  const orderBy = {
    newest: desc(products.createdAt),
    price_asc: asc(products.priceEur),
    price_desc: desc(products.priceEur),
    title_asc: asc(products.title),
  }[query.sort];

  const rows = await db
    .select()
    .from(products)
    .where(whereClause)
    .orderBy(orderBy)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const items = await Promise.all(rows.map((row) => toPublicProduct(db, row)));

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getPublicProductBySlug(db: DbClient, slug: string): Promise<PublicProduct> {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.status, ProductStatus.Published)));
  if (!row) throw new NotFoundError("Product not found");
  return toPublicProduct(db, row);
}

/** Related products: same category, published, excluding the given product, most recent first. */
export async function listRelatedProducts(
  db: DbClient,
  productId: string,
  categoryId: string | undefined,
  limit = 4,
): Promise<PublicProduct[]> {
  if (!categoryId) return [];
  const rows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.status, ProductStatus.Published),
        eq(products.categoryId, categoryId),
        sql`${products.id} != ${productId}`,
      ),
    )
    .orderBy(desc(products.createdAt))
    .limit(limit);
  return Promise.all(rows.map((row) => toPublicProduct(db, row)));
}

/** Archive / Sold Gallery: Sold status AND showInArchiveAfterSale true. */
export async function listArchiveProducts(db: DbClient, query: { page: number; pageSize: number }) {
  const whereClause = and(
    eq(products.status, ProductStatus.Sold),
    eq(products.showInArchiveAfterSale, true),
  );

  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(products).where(whereClause);

  const rows = await db
    .select()
    .from(products)
    .where(whereClause)
    .orderBy(desc(products.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const items = await Promise.all(rows.map((row) => toPublicProduct(db, row)));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function listPublicCategories(db: DbClient): Promise<PublicCategory[]> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.displayOrder));
  return rows.map(toPublicCategory);
}

export async function getPublicCategoryBySlug(db: DbClient, slug: string): Promise<PublicCategory> {
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.slug, slug), eq(categories.isActive, true)));
  if (!row) throw new NotFoundError("Category not found");
  return toPublicCategory(row);
}

export async function listPublicCollections(db: DbClient): Promise<PublicCollection[]> {
  const rows = await db
    .select()
    .from(collections)
    .where(eq(collections.isActive, true))
    .orderBy(asc(collections.displayOrder));
  return rows.map(toPublicCollection);
}

export async function getPublicCollectionBySlug(db: DbClient, slug: string): Promise<PublicCollection> {
  const [row] = await db
    .select()
    .from(collections)
    .where(and(eq(collections.slug, slug), eq(collections.isActive, true)));
  if (!row) throw new NotFoundError("Collection not found");
  return toPublicCollection(row);
}
