import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { categories, collections, productImages, productPhotos, products } from "../db/schema";
import { NotFoundError } from "./errors";
import type { PublicProductListQuery } from "../validation/publicCatalog";
import { createProductReadServiceContextForDb } from "../repositories/product-read/factory";
import type { ProductReadServiceContext } from "../repositories/product-read/types";

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
  context?: ProductReadServiceContext,
): Promise<PublicProduct> {
  context ??= createProductReadServiceContextForDb(db);
  const photos = await context.repositories.photos.listReadyByProduct(row.id);
  const images = await context.repositories.photos.listLegacyCompatibleByProduct(row.id);
  const cat = row.categoryId ? await context.repositories.categories.getById(row.categoryId) : undefined;
  const col = row.collectionId ? await context.repositories.collections.getById(row.collectionId) : undefined;
  return {
    id: row.id, slug: row.slug, title: row.title, type: row.type as ProductType, description: row.description ?? undefined, productStory: row.productStory ?? undefined, brand: row.brand ?? undefined, model: row.model ?? undefined, manufacturer: row.manufacturer ?? undefined, countryOfOrigin: row.countryOfOrigin ?? undefined, period: row.period ?? undefined, materials: row.materials ?? undefined, lengthValue: row.lengthValue ?? undefined, widthValue: row.widthValue ?? undefined, heightValue: row.heightValue ?? undefined, dimensionUnit: row.dimensionUnit ?? undefined, weightValue: row.weightValue ?? undefined, weightUnit: row.weightUnit ?? undefined, condition: row.condition ?? undefined, conditionDescription: row.conditionDescription ?? undefined, priceEur: row.priceEur, priceUsd: row.priceUsd ?? undefined, videoUrl: row.videoUrl ?? undefined, shippingNote: row.shippingNote ?? undefined, customsWarning: row.customsWarning, isFeatured: row.isFeatured, allowMakeOffer: row.allowMakeOffer, allowCashOnDelivery: row.allowCashOnDelivery, status: row.status as ProductStatus, categoryId: row.categoryId ?? undefined, categoryName: cat?.name, categorySlug: cat?.slug, collectionId: row.collectionId ?? undefined, collectionName: col?.name, collectionSlug: col?.slug, seoTitle: row.seoTitle ?? undefined, metaDescription: row.metaDescription ?? undefined,
    photos: photos.map((photo: any) => ({ id: photo.id, url: photo.url, thumbnailUrl: photo.thumbnailUrl ?? undefined, altText: photo.altText ?? undefined, sortOrder: photo.sortOrder, isPrimary: photo.isPrimary })),
    images: images.map((img: any) => ({ id: img.id, url: img.url, thumbnailUrl: img.thumbnailUrl ?? undefined, altText: img.altText ?? undefined, sortOrder: img.sortOrder, isPrimary: img.isPrimary })),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export async function listPublicProducts(db: DbClient, query: PublicProductListQuery, context?: ProductReadServiceContext) {
  const q = { ...query, published: true };
  context ??= createProductReadServiceContextForDb(db);
  const rows = await context.repositories.products.list(q);
  const total = await context.repositories.products.count(q);
  const items = await Promise.all(rows.map((row: any) => toPublicProduct(db, row, context)));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getPublicProductBySlug(db: DbClient, slug: string, context?: ProductReadServiceContext): Promise<PublicProduct> {
  context ??= createProductReadServiceContextForDb(db);
  const rows = await context.repositories.products.list({ published: true, pageSize: 100 });
  const row = rows.find((p: any) => p.slug === slug);
  if (!row) throw new NotFoundError("Product not found");
  return toPublicProduct(db, row, context);
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

export async function listPublicCategories(db: DbClient, context?: ProductReadServiceContext): Promise<PublicCategory[]> {
  context ??= createProductReadServiceContextForDb(db);
  const rows = await context.repositories.categories.listPublic();
  return rows.map(toPublicCategory);
}

export async function getPublicCategoryBySlug(db: DbClient, slug: string, context?: ProductReadServiceContext): Promise<PublicCategory> {
  context ??= createProductReadServiceContextForDb(db);
  const row = await context.repositories.categories.getBySlug(slug);
  if (!row || !row.isActive) throw new NotFoundError("Category not found");
  return toPublicCategory(row);
}

export async function listPublicCollections(db: DbClient, context?: ProductReadServiceContext): Promise<PublicCollection[]> {
  context ??= createProductReadServiceContextForDb(db);
  const rows = await context.repositories.collections.listPublic();
  return rows.map(toPublicCollection);
}

export async function getPublicCollectionBySlug(db: DbClient, slug: string, context?: ProductReadServiceContext): Promise<PublicCollection> {
  context ??= createProductReadServiceContextForDb(db);
  const row = await context.repositories.collections.getBySlug(slug);
  if (!row || !row.isActive) throw new NotFoundError("Collection not found");
  return toPublicCollection(row);
}
