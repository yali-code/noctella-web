import { and, asc, desc, eq, gt, ilike, like, or, sql } from "drizzle-orm";
import type { ProductBreakdownDimension, ProductReadListQuery, ProductReadRepositoryBundle } from "./types";

const MAX_PAGE_SIZE = 100;
const pageSize = (q: ProductReadListQuery = {}) => Math.min(Math.max(Number(q.pageSize ?? q.limit ?? 25), 1), MAX_PAGE_SIZE);
const offset = (q: ProductReadListQuery = {}) => q.offset ?? ((Math.max(Number(q.page ?? 1), 1) - 1) * pageSize(q));
const searchTerm = (s?: string) => s?.trim().replace(/[%_]/g, "\\$&");

export function createDrizzleProductReadRepositories(db: any, schema: any, dialect: "sqlite" | "postgres"): ProductReadRepositoryBundle {
  const { products, categories, collections, productPhotos, productImages } = schema;
  const contains = (col: any, value: string) => dialect === "postgres" ? ilike(col, `%${value}%`) : like(sql`lower(${col})`, `%${value.toLowerCase()}%`);
  const numericFields = ["lengthValue","widthValue","heightValue","weightValue","purchaseCost","priceEur","priceUsd","minOfferPrice","ebayListingPriceEur","etsyListingPriceEur","wooListingPriceEur"];
  const mapProduct = (row: any) => { if (!row) return row; const copy = { ...row }; for (const key of numericFields) if (copy[key] != null) copy[key] = Number(copy[key]); return copy; };
  const productWhere = async (q: ProductReadListQuery = {}) => {
    const filters: any[] = [];
    if (q.search) { const s = searchTerm(q.search); if (s) filters.push(or(contains(products.title, s), contains(products.sku, s), contains(products.description, s))); }
    if (q.status) filters.push(eq(products.status, q.status));
    if (q.type) filters.push(eq(products.type, q.type));
    if (q.categoryId) filters.push(eq(products.categoryId, q.categoryId));
    if (q.collectionId) filters.push(eq(products.collectionId, q.collectionId));
    if (q.published) filters.push(eq(products.status, "published"));
    if (q.isFeatured !== undefined) filters.push(eq(products.isFeatured, q.isFeatured));
    if (q.updatedSince) filters.push(gt(products.updatedAt, dialect === "postgres" ? new Date(q.updatedSince) : q.updatedSince));
    if (q.categorySlug) { const c = await categoriesRepo.getBySlug(q.categorySlug); filters.push(eq(products.categoryId, c?.id ?? "__no_match__")); }
    if (q.collectionSlug) { const c = await collectionsRepo.getBySlug(q.collectionSlug); filters.push(eq(products.collectionId, c?.id ?? "__no_match__")); }
    return filters.length ? and(...filters) : undefined;
  };
  const breakdownColumns: Record<ProductBreakdownDimension, any> = { category: products.categoryId, brand: products.brand, condition: products.condition, workflowStatus: products.status };
  const order = (q: ProductReadListQuery = {}) => {
    if (q.sort === "sku_asc") return [asc(products.sku), asc(products.id)];
    if (q.sort === "price_asc") return [asc(products.priceEur), asc(products.id)];
    if (q.sort === "price_desc") return [desc(products.priceEur), asc(products.id)];
    if (q.sort === "title_asc") return [asc(products.title), asc(products.id)];
    if (q.sort === "newest") return [desc(products.createdAt), asc(products.id)];
    return [desc(products.updatedAt), asc(products.id)];
  };
  const productsRepo = {
    getById: async (id: string) => mapProduct((await db.select().from(products).where(eq(products.id, id)).limit(1))[0]),
    getBySku: async (sku: string) => mapProduct((await db.select().from(products).where(eq(products.sku, sku)).limit(1))[0]),
    getByErpReference: async (erpReferenceId: string) => mapProduct((await db.select().from(products).where(eq(products.erpReferenceId, erpReferenceId)).limit(1))[0]),
    getByNoctellaId: async (id: string) => productsRepo.getById(id),
    list: async (q: ProductReadListQuery = {}) => (await db.select().from(products).where(await productWhere(q)).orderBy(...order(q)).limit(pageSize(q)).offset(offset(q))).map(mapProduct),
    listForExport: async (q: ProductReadListQuery = {}) => (await db.select().from(products).where(await productWhere(q)).orderBy(...order(q)).limit(Number(q.limit ?? MAX_PAGE_SIZE)).offset(q.offset ?? 0)).map(mapProduct),
    breakdownByDimension: async (dimension: ProductBreakdownDimension) => { const key = sql<string>`coalesce(${breakdownColumns[dimension]}, 'Unknown')`; return db.select({ key, productCount: sql<number>`count(*)`, stockQuantity: sql<number>`sum(${products.stockQuantity})`, inventoryValue: sql<number>`sum(${products.priceEur} * ${products.stockQuantity})` }).from(products).groupBy(key).orderBy(asc(key)); },
    search: async (query: string, q: ProductReadListQuery = {}) => productsRepo.list({ ...q, search: query }),
    count: async (q: ProductReadListQuery = {}) => Number((await db.select({ total: sql<number>`count(*)` }).from(products).where(await productWhere(q)))[0]?.total ?? 0),
    listUpdatedSince: async (updatedSince: string, q: ProductReadListQuery = {}) => productsRepo.list({ ...q, updatedSince }),
    listByCategory: async (categoryId: string, q: ProductReadListQuery = {}) => productsRepo.list({ ...q, categoryId }),
    listByCollection: async (collectionId: string, q: ProductReadListQuery = {}) => productsRepo.list({ ...q, collectionId }),
    listByStatus: async (status: string, q: ProductReadListQuery = {}) => productsRepo.list({ ...q, status }),
    listPublished: async (q: ProductReadListQuery = {}) => productsRepo.list({ ...q, published: true }),
    getAvailabilityProjection: async (productId: string) => { const p = await productsRepo.getById(productId); return p ? { productId, physicalStock: p.stockQuantity, reservedStock: 0, reservedStockSupported: false, availableStock: p.stockQuantity, availableQuantity: p.stockQuantity } : undefined; },
    getWorkspaceReadProjection: async (productId: string) => productsRepo.getById(productId),
  };
  const categoriesRepo = {
    getById: async (id: string) => (await db.select().from(categories).where(eq(categories.id, id)).limit(1))[0],
    getBySlug: async (slug: string) => (await db.select().from(categories).where(eq(categories.slug, slug)).limit(1))[0],
    list: async (q: any = {}) => db.select().from(categories).where(q.includeInactive ? undefined : eq(categories.isActive, true)).orderBy(asc(categories.displayOrder), asc(categories.id)).limit(pageSize(q)).offset(offset(q)),
    count: async (q: any = {}) => Number((await db.select({ total: sql<number>`count(*)` }).from(categories).where(q.includeInactive ? undefined : eq(categories.isActive, true)))[0]?.total ?? 0),
    listWithProductCounts: async () => db.select({ category: categories, productCount: sql<number>`count(${products.id})` }).from(categories).leftJoin(products, eq(products.categoryId, categories.id)).groupBy(categories.id).orderBy(asc(categories.displayOrder), asc(categories.id)),
    listPublic: async () => db.select().from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.displayOrder), asc(categories.id)),
  };
  const collectionsRepo = {
    getById: async (id: string) => (await db.select().from(collections).where(eq(collections.id, id)).limit(1))[0],
    getBySlug: async (slug: string) => (await db.select().from(collections).where(eq(collections.slug, slug)).limit(1))[0],
    list: async (q: any = {}) => db.select().from(collections).where(q.includeInactive ? undefined : eq(collections.isActive, true)).orderBy(asc(collections.displayOrder), asc(collections.id)).limit(pageSize(q)).offset(offset(q)),
    count: async (q: any = {}) => Number((await db.select({ total: sql<number>`count(*)` }).from(collections).where(q.includeInactive ? undefined : eq(collections.isActive, true)))[0]?.total ?? 0),
    listWithProductCounts: async () => db.select({ collection: collections, productCount: sql<number>`count(${products.id})` }).from(collections).leftJoin(products, eq(products.collectionId, collections.id)).groupBy(collections.id).orderBy(asc(collections.displayOrder), asc(collections.id)),
    listPublic: async () => db.select().from(collections).where(eq(collections.isActive, true)).orderBy(asc(collections.displayOrder), asc(collections.id)),
  };
  const photosRepo = {
    getById: async (id: string) => (await db.select().from(productPhotos).where(eq(productPhotos.id, id)).limit(1))[0],
    listByProduct: async (productId: string) => db.select().from(productPhotos).where(eq(productPhotos.productId, productId)).orderBy(asc(productPhotos.sortOrder), asc(productPhotos.id)),
    getPrimaryByProduct: async (productId: string) => (await db.select().from(productPhotos).where(eq(productPhotos.productId, productId)).orderBy(desc(productPhotos.isPrimary), asc(productPhotos.sortOrder), asc(productPhotos.id)).limit(1))[0],
    countByProduct: async (productId: string) => Number((await db.select({ total: sql<number>`count(*)` }).from(productPhotos).where(eq(productPhotos.productId, productId)))[0]?.total ?? 0),
    listReadyByProduct: async (productId: string) => db.select().from(productPhotos).where(and(eq(productPhotos.productId, productId), eq(productPhotos.processingStatus, "Ready"))).orderBy(asc(productPhotos.sortOrder), asc(productPhotos.id)),
    listAdminByProduct: async (productId: string) => photosRepo.listByProduct(productId),
    listLegacyCompatibleByProduct: async (productId: string) => { const photos = await photosRepo.listReadyByProduct(productId); return photos.length ? photos : db.select().from(productImages).where(eq(productImages.productId, productId)).orderBy(asc(productImages.sortOrder), asc(productImages.id)); },
  };
  return { products: productsRepo, categories: categoriesRepo, collections: collectionsRepo, photos: photosRepo };
}
