import { and, asc, eq } from "drizzle-orm";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { ProductWriteRepositoryBundle, SynchronousProductWriteRepository } from "./types";

const table = (schema: typeof sqliteSchema | typeof postgresSchema, name: keyof typeof sqliteSchema) => (schema as Record<string, any>)[name];
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> => value instanceof Promise ? value.then(next) : next(value);
const rows = (q: any, execution: Execution = "asynchronous"): Result<any[]> => execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);
const first = (q: any, execution: Execution = "asynchronous"): Result<any> => then(typeof q?.limit === "function" ? rows(q.limit(1), execution) : rows(q, execution), values => values[0] ?? null);
const run = (q: any, execution: Execution = "asynchronous"): Result<unknown> => execution === "synchronous" ? q.run() : Promise.resolve(q);
const bool = (v: unknown) => v === true || v === 1;

export function createDrizzleProductWriteRepositories(db: any, schema: typeof sqliteSchema | typeof postgresSchema, dialect: "sqlite" | "postgres", execution: Execution = "asynchronous"): any {
  const products = table(schema, "products"), productErpMetadata = table(schema, "productErpMetadata"), categories = table(schema, "categories"), collections = table(schema, "collections"), productPhotos = table(schema, "productPhotos");
  const normalize = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k,v]) => [k, v === undefined ? null : v]));
  const exists = (tbl: any, col: any, value: string, excludeId?: string, idCol = tbl.id) => then(rows(db.select({ id: idCol }).from(tbl).where(eq(col, value)), execution), values => values.some((r: any) => r.id !== excludeId));
  const productRepository: SynchronousProductWriteRepository = {
      create({ values }) { return then(run(db.insert(products).values(normalize(values)), execution), () => ({ id: String(values.id) })) as any; },
      update({ id, values }) { return then(run(db.update(products).set(normalize(values)).where(eq(products.id, id)), execution), () => ({ id, updated: true })) as any; },
      existsBySku: (sku, excludeId) => exists(products, products.sku, sku, excludeId) as any,
      existsByErpReference: (erpReferenceId, excludeId) => exists(products, products.erpReferenceId, erpReferenceId, excludeId) as any,
      existsByNoctellaId(noctellaId, excludeProductId) { return exists(productErpMetadata, productErpMetadata.noctellaId, noctellaId, excludeProductId, productErpMetadata.productId) as any; },
      getVersionForUpdate(id) { return then(first(db.select({ updatedAt: products.updatedAt }).from(products).where(eq(products.id, id)), execution), row => row?.updatedAt ?? null); },
      updateWithExpectedVersion({ id, values, expectedUpdatedAt }) { return then(this.getVersionForUpdate(id), current => { if (!current) return { id, updated: false, conflict: { field: "id", value: id, message: "Product not found" } }; if (expectedUpdatedAt && current !== expectedUpdatedAt) return { id, updated: false, conflict: { field: "updatedAt", value: expectedUpdatedAt, message: "Product has changed since expectedUpdatedAt" } }; return then(this.update({ id, values }), () => ({ id, updated: true })); }) as any; },
      createErpMetadata(record) { return then(run(db.insert(productErpMetadata).values(normalize(record)), execution), () => undefined); },
      updateErpMetadata(productId, values) { return then(run(db.update(productErpMetadata).set(normalize(values)).where(eq(productErpMetadata.productId, productId)), execution), () => undefined); },
      getErpMetadataForUpdate(productId) { return then(first(db.select().from(productErpMetadata).where(eq(productErpMetadata.productId, productId)), execution), row => row ?? null); },
    };
  const bundle: ProductWriteRepositoryBundle = {
    products: productRepository as unknown as ProductWriteRepositoryBundle["products"],
    categories: {
      async create({ values }) { await run(db.insert(categories).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(categories).set(normalize(values)).where(eq(categories.id, id))); return { id }; },
      existsByName: (name, excludeId) => Promise.resolve(exists(categories, categories.name, name, excludeId)),
      existsBySlug: (slug, excludeId) => Promise.resolve(exists(categories, categories.slug, slug, excludeId)),
      async getVersionForUpdate(id) { return (await first(db.select({ updatedAt: categories.updatedAt }).from(categories).where(eq(categories.id, id))))?.updatedAt ?? null; },
    },
    collections: {
      async create({ values }) { await run(db.insert(collections).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(collections).set(normalize(values)).where(eq(collections.id, id))); return { id }; },
      existsByName: (name, excludeId) => Promise.resolve(exists(collections, collections.name, name, excludeId)),
      existsBySlug: (slug, excludeId) => Promise.resolve(exists(collections, collections.slug, slug, excludeId)),
      async getVersionForUpdate(id) { return (await first(db.select({ updatedAt: collections.updatedAt }).from(collections).where(eq(collections.id, id))))?.updatedAt ?? null; },
    },
    photos: {
      createMetadata({ values }) { const q = db.insert(productPhotos).values(normalize(values)); if (typeof q?.run === "function") q.run(); else return Promise.resolve(q).then(() => ({ id: String(values.id) })); return Promise.resolve({ id: String(values.id) }); },
      updateAltText({ productId, photoId, altText }) { const q = db.update(productPhotos).set({ altText, updatedAt: new Date().toISOString() }).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q?.run === "function") q.run(); return Promise.resolve(); },
      setPrimary({ productId, photoId }) { const now = new Date().toISOString(); const q1 = db.update(productPhotos).set({ isPrimary: dialect === "postgres" ? 0 : false, updatedAt: now }).where(eq(productPhotos.productId, productId)); if (typeof q1?.run === "function") q1.run(); const q2 = db.update(productPhotos).set({ isPrimary: dialect === "postgres" ? 1 : true, updatedAt: now }).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q2?.run === "function") q2.run(); return Promise.resolve(); },
      reorder({ productId, photoIds }) { const now = new Date().toISOString(); for (const [sortOrder, photoId] of photoIds.entries()) { const q = db.update(productPhotos).set({ sortOrder, updatedAt: now }).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q?.run === "function") q.run(); } return Promise.resolve(); },
      deleteMetadata({ productId, photoId }) { const q = db.delete(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))); if (typeof q?.run === "function") q.run(); return Promise.resolve(); },
      async promoteNextPrimary(productId) { const list = await this.listForUpdate(productId); if (!list.length) return; const primary = list.find((p: any) => bool(p.isPrimary)) ?? list[0]; await this.setPrimary({ productId, photoId: String(primary.id) }); },
      async updateProcessingState(photoId, state) { await run(db.update(productPhotos).set({ ...state, updatedAt: state.processingUpdatedAt }).where(eq(productPhotos.id, photoId))); },
      async updateStorageMetadata(photoId, metadata) { await run(db.update(productPhotos).set({ ...metadata, updatedAt: new Date().toISOString() }).where(eq(productPhotos.id, photoId))); },
      async getForUpdate(productId, photoId) { return (await first(db.select().from(productPhotos).where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId))))) ?? null; },
      async listForUpdate(productId) { return rows(db.select().from(productPhotos).where(eq(productPhotos.productId, productId)).orderBy(asc(productPhotos.sortOrder))); },
    },
  };
  return bundle;
}
