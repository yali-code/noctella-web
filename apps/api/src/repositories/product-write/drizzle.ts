import { and, asc, eq } from "drizzle-orm";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { ProductWriteRepositoryBundle } from "./types";

const table = (schema: typeof sqliteSchema | typeof postgresSchema, name: keyof typeof sqliteSchema) => (schema as Record<string, any>)[name];
const first = async (q: any) => Array.isArray(q) ? q[0] : (typeof q?.limit === "function" ? (await q.limit(1))[0] : (await q)[0]);
const rows = async (q: any) => Array.isArray(q) ? q : await q;
const run = async (q: any) => { if (typeof q?.run === "function") return q.run(); return q; };
const bool = (v: unknown) => v === true || v === 1;

export function createDrizzleProductWriteRepositories(db: any, schema: typeof sqliteSchema | typeof postgresSchema, dialect: "sqlite" | "postgres"): ProductWriteRepositoryBundle {
  const products = table(schema, "products"), productErpMetadata = table(schema, "productErpMetadata"), categories = table(schema, "categories"), collections = table(schema, "collections"), productPhotos = table(schema, "productPhotos");
  const normalize = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k,v]) => [k, v === undefined ? null : v]));
  const exists = async (tbl: any, col: any, value: string, excludeId?: string, idCol = tbl.id) => (await rows(db.select({ id: idCol }).from(tbl).where(eq(col, value)))).some((r: any) => r.id !== excludeId);
  return {
    products: {
      async create({ values }) { await run(db.insert(products).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(products).set(normalize(values)).where(eq(products.id, id))); return { id, updated: true }; },
      existsBySku: (sku, excludeId) => exists(products, products.sku, sku, excludeId),
      existsByErpReference: (erpReferenceId, excludeId) => exists(products, products.erpReferenceId, erpReferenceId, excludeId),
      async existsByNoctellaId(noctellaId, excludeProductId) { return exists(productErpMetadata, productErpMetadata.noctellaId, noctellaId, excludeProductId, productErpMetadata.productId); },
      async getVersionForUpdate(id) { return (await first(db.select({ updatedAt: products.updatedAt }).from(products).where(eq(products.id, id))))?.updatedAt ?? null; },
      async updateWithExpectedVersion({ id, values, expectedUpdatedAt }) { const current = await this.getVersionForUpdate(id); if (!current) return { id, updated: false, conflict: { field: "id", value: id, message: "Product not found" } }; if (expectedUpdatedAt && current !== expectedUpdatedAt) return { id, updated: false, conflict: { field: "updatedAt", value: expectedUpdatedAt, message: "Product has changed since expectedUpdatedAt" } }; await this.update({ id, values }); return { id, updated: true }; },
      async createErpMetadata(record) { await run(db.insert(productErpMetadata).values(normalize(record))); },
      async updateErpMetadata(productId, values) { await run(db.update(productErpMetadata).set(normalize(values)).where(eq(productErpMetadata.productId, productId))); },
      async getErpMetadataForUpdate(productId) { return (await first(db.select().from(productErpMetadata).where(eq(productErpMetadata.productId, productId)))) ?? null; },
    },
    categories: {
      async create({ values }) { await run(db.insert(categories).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(categories).set(normalize(values)).where(eq(categories.id, id))); return { id }; },
      existsByName: (name, excludeId) => exists(categories, categories.name, name, excludeId),
      existsBySlug: (slug, excludeId) => exists(categories, categories.slug, slug, excludeId),
      async getVersionForUpdate(id) { return (await first(db.select({ updatedAt: categories.updatedAt }).from(categories).where(eq(categories.id, id))))?.updatedAt ?? null; },
    },
    collections: {
      async create({ values }) { await run(db.insert(collections).values(normalize(values))); return { id: String(values.id) }; },
      async update({ id, values }) { await run(db.update(collections).set(normalize(values)).where(eq(collections.id, id))); return { id }; },
      existsByName: (name, excludeId) => exists(collections, collections.name, name, excludeId),
      existsBySlug: (slug, excludeId) => exists(collections, collections.slug, slug, excludeId),
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
}
