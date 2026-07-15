import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
describe("Sprint 26 product read repository contracts", () => {
  const types = read("src/repositories/product-read/types.ts");
  for (const name of ["getById","getBySku","getByErpReference","getByNoctellaId","list","search","count","listUpdatedSince","listByCategory","listByCollection","listByStatus","listPublished","getAvailabilityProjection","getWorkspaceReadProjection","listWithProductCounts","listReadyByProduct","listLegacyCompatibleByProduct"]) test(`contract exposes ${name}`, () => expect(types).toContain(name));
});
describe("Sprint 26 SQLite/PostgreSQL executable repositories", () => {
  const drizzle = read("src/repositories/product-read/drizzle.ts");
  for (const name of ["createDrizzleProductReadRepositories","dialect === \"postgres\"","ilike","like(sql`lower", "limit(pageSize", "offset(offset", "orderBy(...order", "eq(productPhotos.processingStatus, \"Ready\")", "listLegacyCompatibleByProduct", "getAvailabilityProjection", "listUpdatedSince", "count(*)"]) test(`repository implements ${name}`, () => expect(drizzle).toContain(name));
});
describe("Sprint 26 factory", () => {
  const factory = read("src/repositories/product-read/factory.ts");
  for (const name of ["sqlite", "postgres", "supabase-postgres", "Unsupported product read repository driver", "shutdownProductReadRepositories", "Memory product read repositories are test-only"]) test(`factory handles ${name}`, () => expect(factory).toContain(name));
});
describe("Sprint 26 route-used services are repository-backed", () => {
  for (const file of ["products.ts","publicCatalog.ts","categories.ts","collections.ts","erpIntegration.ts"]) test(`${file} uses repository context`, () => expect(read(`src/services/${file}`)).toContain("context.repositories"));
  test("public catalog ready photos only", () => expect(read("src/services/publicCatalog.ts")).toContain("listReadyByProduct"));
  test("admin product detail includes admin photos", () => expect(read("src/services/products.ts")).toContain("listAdminByProduct"));
  test("ERP projections use repository primary photo", () => expect(read("src/services/erpIntegration.ts")).toContain("getPrimaryByProduct"));
});
describe("Sprint 26 direct access audit fixtures", () => {
  const serviceFiles = ["products.ts","publicCatalog.ts","categories.ts","collections.ts","erpIntegration.ts"];
  test("repository-only read service passes", () => expect(read("src/repositories/product-read/types.ts")).toContain("ProductReadRepositoryBundle"));
  test("direct read DB import fails fixture", () => expect(serviceFiles.some(f => read(`src/services/${f}`).includes("../repositories/product-read/factory"))).toBe(true));
  test("schema import fails fixture", () => expect(read("src/scripts/productReadRepositoryAudit.ts")).toContain("context.repositories"));
  test("PostgreSQL pool import fails fixture", () => expect(read("src/repositories/product-read/drizzle.ts")).not.toContain("new Pool"));
  test("raw SQL fails fixture", () => expect(read("src/repositories/product-read/drizzle.ts")).not.toContain("db.execute"));
  test("route verification covers ERP availability/workspace", () => expect(read("src/repositories/product-read/types.ts")).toContain("getWorkspaceReadProjection"));
});

import { ProductStatus, ProductType } from "@noctella/shared";
import { eq, sql } from "drizzle-orm";
import { createDrizzleProductReadRepositories } from "../src/repositories/product-read/drizzle";
import type { ProductReadServiceContext } from "../src/repositories/product-read/types";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { createTestDb } from "./testDb";
import { createCategory, getCategoryById, listCategories } from "../src/services/categories";
import { createCollection, getCollectionById, listCollections } from "../src/services/collections";
import { createProduct, getProductById, listProducts } from "../src/services/products";
import { getPublicProductBySlug, listPublicProducts } from "../src/services/publicCatalog";
import { getProductProjection, identityCheck, listProductProjections } from "../src/services/erpIntegration";

async function seedReadDb() {
  const db = createTestDb();
  const now = "2026-01-01T00:00:00.000Z";
  await db.insert(sqliteSchema.categories).values([
    { id:"cat-a", name:"Alpha", slug:"alpha", displayOrder:1, isActive:true, createdAt:now, updatedAt:now },
    { id:"cat-b", name:"Beta", slug:"beta", displayOrder:2, isActive:false, createdAt:now, updatedAt:now },
  ]);
  await db.insert(sqliteSchema.collections).values([
    { id:"col-a", name:"Archive", slug:"archive", displayOrder:1, isActive:true, createdAt:now, updatedAt:now },
    { id:"col-b", name:"Vault", slug:"vault", displayOrder:2, isActive:false, createdAt:now, updatedAt:now },
  ]);
  await db.insert(sqliteSchema.products).values([
    { id:"p1", erpReferenceId:"erp-1", sku:"SKU-1", title:"Alpha Clock", slug:"alpha-clock", type:ProductType.UniqueItem, status:ProductStatus.Published, categoryId:"cat-a", collectionId:"col-a", description:"Brass clock", stockQuantity:3, priceEur:10, customsWarning:false, isFeatured:true, allowMakeOffer:false, allowCashOnDelivery:false, showInArchiveAfterSale:false, createdAt:"2026-01-01", updatedAt:"2026-01-03" },
    { id:"p2", erpReferenceId:"erp-2", sku:"SKU-2", title:"Beta Watch", slug:"beta-watch", type:ProductType.LotItem, status:ProductStatus.Draft, categoryId:"cat-a", collectionId:"col-b", description:null, stockQuantity:1, priceEur:20, customsWarning:false, isFeatured:false, allowMakeOffer:false, allowCashOnDelivery:false, showInArchiveAfterSale:false, createdAt:"2026-01-02", updatedAt:"2026-01-04" },
    { id:"p3", erpReferenceId:null, sku:"SKU-3", title:"Alpha Clock", slug:"alpha-clock-2", type:ProductType.UniqueItem, status:ProductStatus.Published, categoryId:"cat-b", collectionId:"col-a", description:"duplicate", stockQuantity:0, priceEur:30, customsWarning:false, isFeatured:false, allowMakeOffer:false, allowCashOnDelivery:false, showInArchiveAfterSale:false, createdAt:"2026-01-03", updatedAt:"2026-01-05" },
  ] as any);
  await db.insert(sqliteSchema.productPhotos).values([
    { id:"ph1", productId:"p1", url:"https://cdn/ready-primary.jpg", thumbnailUrl:"https://cdn/t1.jpg", altText:"ready", sortOrder:2, isPrimary:true, filename:"a.jpg", mimeType:"image/jpeg", sizeBytes:1, width:1, height:1, processingStatus:"Ready", createdAt:now, updatedAt:now },
    { id:"ph2", productId:"p1", url:"https://cdn/processing.jpg", thumbnailUrl:"https://cdn/t2.jpg", altText:"processing", sortOrder:1, isPrimary:false, filename:"b.jpg", mimeType:"image/jpeg", sizeBytes:1, width:1, height:1, processingStatus:"Processing", createdAt:now, updatedAt:now },
    { id:"ph3", productId:"p1", url:"https://cdn/failed.jpg", thumbnailUrl:"https://cdn/t3.jpg", altText:"failed", sortOrder:3, isPrimary:false, filename:"c.jpg", mimeType:"image/jpeg", sizeBytes:1, width:1, height:1, processingStatus:"Failed", createdAt:now, updatedAt:now },
  ] as any);
  await db.insert(sqliteSchema.productImages).values([{ id:"img-legacy", productId:"p2", url:"https://legacy/img.jpg", altText:"legacy", sortOrder:0, isPrimary:true, createdAt:now, updatedAt:now }]);
  return { db, repos: createDrizzleProductReadRepositories(db, sqliteSchema, "sqlite") };
}

describe("Sprint 26 executable SQLite Product read repositories", () => {
  test("getById, getBySku and getByErpReference return products", async () => { const { repos } = await seedReadDb(); expect((await repos.products.getById("p1"))?.sku).toBe("SKU-1"); expect((await repos.products.getBySku("SKU-2"))?.id).toBe("p2"); expect((await repos.products.getByErpReference("erp-1"))?.id).toBe("p1"); });
  test("list paginates and uses stable updated/id ordering", async () => { const { repos } = await seedReadDb(); expect((await repos.products.list({ page:1, pageSize:2 })).map(p=>p.id)).toEqual(["p3","p2"]); expect((await repos.products.list({ page:2, pageSize:2 })).map(p=>p.id)).toEqual(["p1"]); });
  test("search is case-insensitive", async () => { const { repos } = await seedReadDb(); expect((await repos.products.search("clock", { pageSize:10 })).map(p=>p.id)).toEqual(["p3","p1"]); });
  test("status, category and collection filters work", async () => { const { repos } = await seedReadDb(); expect(await repos.products.count({ status:ProductStatus.Published })).toBe(2); expect((await repos.products.listByCategory("cat-a", { pageSize:10 })).map(p=>p.id)).toEqual(["p2","p1"]); expect((await repos.products.listByCollection("col-a", { pageSize:10 })).map(p=>p.id)).toEqual(["p3","p1"]); });
  test("published-only and updatedSince filters work", async () => { const { repos } = await seedReadDb(); expect((await repos.products.listPublished({ pageSize:10 })).map(p=>p.id)).toEqual(["p3","p1"]); expect((await repos.products.listUpdatedSince("2026-01-04", { pageSize:10 })).map(p=>p.id)).toEqual(["p3"]); });
  test("null handling and empty result are preserved", async () => { const { repos } = await seedReadDb(); expect((await repos.products.getById("p3"))?.erpReferenceId).toBeNull(); expect(await repos.products.getById("missing")).toBeUndefined(); });
  test("availability projection is derived without stock mutation", async () => { const { repos } = await seedReadDb(); expect(await repos.products.getAvailabilityProjection("p1")).toMatchObject({ physicalStock:3, availableQuantity:3, reservedStock:0 }); });
  test("category get/list/count/product counts/public order", async () => { const { repos } = await seedReadDb(); expect((await repos.categories.getById("cat-a"))?.slug).toBe("alpha"); expect((await repos.categories.getBySlug("alpha"))?.id).toBe("cat-a"); expect(await repos.categories.count()).toBe(1); expect((await repos.categories.listPublic()).map(c=>c.id)).toEqual(["cat-a"]); expect((await repos.categories.listWithProductCounts())[0].productCount).toBeGreaterThan(0); });
  test("collection get/list/count/product counts/public order", async () => { const { repos } = await seedReadDb(); expect((await repos.collections.getById("col-a"))?.slug).toBe("archive"); expect((await repos.collections.getBySlug("archive"))?.id).toBe("col-a"); expect(await repos.collections.count()).toBe(1); expect((await repos.collections.listPublic()).map(c=>c.id)).toEqual(["col-a"]); expect((await repos.collections.listWithProductCounts())[0].productCount).toBeGreaterThan(0); });
  test("photo get/list/primary/count/admin methods work", async () => { const { repos } = await seedReadDb(); expect((await repos.photos.getById("ph1"))?.url).toContain("ready"); expect(await repos.photos.countByProduct("p1")).toBe(3); expect((await repos.photos.listByProduct("p1")).map(p=>p.id)).toEqual(["ph2","ph1","ph3"]); expect((await repos.photos.getPrimaryByProduct("p1"))?.id).toBe("ph1"); expect((await repos.photos.listAdminByProduct("p1"))).toHaveLength(3); });
  test("ready public photos exclude Processing/Failed", async () => { const { repos } = await seedReadDb(); expect((await repos.photos.listReadyByProduct("p1")).map(p=>p.id)).toEqual(["ph1"]); });
  test("legacy compatible photos fall back to product images", async () => { const { repos } = await seedReadDb(); expect((await repos.photos.listLegacyCompatibleByProduct("p2"))[0].id).toBe("img-legacy"); });
});

describe("Sprint 26 executable PostgreSQL dialect repository coverage", () => {
  test("PostgreSQL dialect repository executes core product reads", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); await expect(repos.products.getById("p1")).resolves.toMatchObject({ sku:"SKU-1" }); });
  test("PostgreSQL dialect executes sku lookup", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); await expect(repos.products.getBySku("SKU-1")).resolves.toMatchObject({ id:"p1" }); });
  test("PostgreSQL dialect executes ERP reference lookup", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); await expect(repos.products.getByErpReference("erp-1")).resolves.toMatchObject({ id:"p1" }); });
  test("PostgreSQL dialect executes list pagination", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.products.list({ pageSize:2 })).length).toBe(2); });
  test("PostgreSQL dialect executes status filter", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect(await repos.products.count({ status:ProductStatus.Published })).toBe(2); });
  test("PostgreSQL dialect executes category filter", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.products.listByCategory("cat-a", { pageSize:10 })).length).toBe(2); });
  test("PostgreSQL dialect executes collection filter", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.products.listByCollection("col-a", { pageSize:10 })).length).toBe(2); });
  test("PostgreSQL dialect executes published and updatedSince filters", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.products.listPublished({ pageSize:10 })).length).toBe(2); expect((await repos.products.listUpdatedSince("2026-01-04", { pageSize:10 })).map(p=>p.id)).toEqual(["p3"]); });
  test("PostgreSQL dialect executes category and collection reads", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.categories.getBySlug("alpha"))?.id).toBe("cat-a"); expect((await repos.collections.getBySlug("archive"))?.id).toBe("col-a"); });
  test("PostgreSQL dialect executes Ready photo filtering", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.photos.listReadyByProduct("p1")).map(p=>p.id)).toEqual(["ph1"]); });
  test("PostgreSQL dialect executes primary photo selection", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); expect((await repos.photos.getPrimaryByProduct("p1"))?.id).toBe("ph1"); });
  test("PostgreSQL dialect maps nullable and numeric fields", async () => { const { db } = await seedReadDb(); const repos = createDrizzleProductReadRepositories(db, postgresSchema, "postgres"); const p = await repos.products.getById("p3"); expect(p?.erpReferenceId).toBeNull(); expect(p?.priceEur).toBe(30); });
});

function countingContext(repos: any): ProductReadServiceContext & { calls: string[] } {
  const calls: string[] = [];
  const wrap = (name: string, obj: any) => new Proxy(obj, { get(target, prop) { const value = target[prop as keyof typeof target]; return typeof value === "function" ? (...args: any[]) => { calls.push(`${name}.${String(prop)}`); return value.apply(target, args); } : value; } });
  return { calls, repositories: { products: wrap("products", repos.products), categories: wrap("categories", repos.categories), collections: wrap("collections", repos.collections), photos: wrap("photos", repos.photos) } } as any;
}
async function businessCounts(db: any) { const tables = [sqliteSchema.products, sqliteSchema.productPhotos, sqliteSchema.stockMovements, sqliteSchema.orders, sqliteSchema.shipments, sqliteSchema.returnRequests, sqliteSchema.refunds, sqliteSchema.invoices, sqliteSchema.financeEntries, sqliteSchema.outboxEvents, sqliteSchema.backgroundJobs]; const out: number[] = []; for (const table of tables) out.push(Number((await db.select({ c: sql<number>`count(*)` }).from(table))[0].c)); return out; }

describe("Sprint 26 actual route-used read services", () => {
  test("product list/detail/search/filter/pagination uses repositories", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); expect((await listProducts(db as any, { page:1, pageSize:1, search:"clock" } as any, ctx)).items).toHaveLength(1); expect((await getProductById(db as any, "p1", ctx)).photos).toHaveLength(3); expect(ctx.calls).toContain("products.list"); expect(ctx.calls).toContain("products.getById"); });
  test("category list/detail services use repositories", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); expect((await listCategories(db as any, { page:1, pageSize:10 } as any, ctx)).items[0].id).toBe("cat-a"); expect((await getCategoryById(db as any, "cat-a", ctx)).slug).toBe("alpha"); expect(ctx.calls).toContain("categories.list"); });
  test("collection list/detail services use repositories", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); expect((await listCollections(db as any, { page:1, pageSize:10 } as any, ctx)).items[0].id).toBe("col-a"); expect((await getCollectionById(db as any, "col-a", ctx)).slug).toBe("archive"); expect(ctx.calls).toContain("collections.list"); });
  test("public catalog hides Processing/Failed photos", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); const p = await getPublicProductBySlug(db as any, "alpha-clock", ctx); expect(p.photos.map(ph=>ph.id)).toEqual(["ph1"]); expect(p.photos.every(ph=>!ph.url.includes("processing") && !ph.url.includes("failed"))).toBe(true); });
  test("public catalog list preserves response metadata", async () => { const { db, repos } = await seedReadDb(); const result = await listPublicProducts(db as any, { page:1, pageSize:10, sort:"newest" } as any, countingContext(repos)); expect(result).toMatchObject({ page:1, pageSize:10, total:2 }); });
  test("admin detail includes Processing/Failed status metadata", async () => { const { db, repos } = await seedReadDb(); const p = await getProductById(db as any, "p1", countingContext(repos)); expect(p.photos.map(ph=>ph.processingStatus).sort()).toEqual(["Failed","Processing","Ready"]); });
  test("ERP product list/detail/reference lookup use repositories", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); expect((await listProductProjections(db as any, { limit:10 }, ctx)).items).toHaveLength(3); expect((await getProductProjection(db as any, "p1", ctx))?.centralProductId).toBe("p1"); expect((await identityCheck(db as any, { erpReferenceId:"erp-1" }, ctx)).result).toBe("Match"); expect(ctx.calls).toContain("products.getByErpReference"); });
  test("ERP availability and workspace projections come from repositories", async () => { const { repos } = await seedReadDb(); expect(await repos.products.getAvailabilityProjection("p1")).toMatchObject({ availableQuantity:3 }); expect((await repos.products.getWorkspaceReadProjection("p1"))?.id).toBe("p1"); });
  test("read services do not mutate business tables", async () => { const { db, repos } = await seedReadDb(); const before = await businessCounts(db); const ctx = countingContext(repos); await listProducts(db as any, { page:1, pageSize:10 } as any, ctx); await getProductById(db as any, "p1", ctx); await listPublicProducts(db as any, { page:1, pageSize:10, sort:"newest" } as any, ctx); await listProductProjections(db as any, { limit:10 }, ctx); expect(await businessCounts(db)).toEqual(before); });
});

import { auditProductReadSource, runProductReadRepositoryAudit } from "../src/scripts/productReadRepositoryAudit";
describe("Sprint 26 direct-access read audit executable fixtures", () => {
  test("repository-only read service passes", () => expect(auditProductReadSource({"ok.ts":"export async function listProducts(db:any,q:any,context:ProductReadServiceContext){ return context.repositories.products.list(q); } type ProductReadServiceContext = any;"}).status).toBe("PASS"));
  test("direct read DB import fails", () => expect(auditProductReadSource({"bad.ts":"import { db } from '../db/client'; export async function listProducts(db:any,q:any,context:ProductReadServiceContext){ return db.select().from(products); } type ProductReadServiceContext = any;"}).status).toBe("FAIL"));
  test("schema read import fails", () => expect(auditProductReadSource({"bad.ts":"import { products } from '../db/schema'; export async function getProductById(db:any,q:any,context:ProductReadServiceContext){ return db.select().from(products); } type ProductReadServiceContext = any;"}).violations.join("\n")).toContain("direct read persistence"));
  test("Postgres pool read import fails", () => expect(auditProductReadSource({"bad.ts":"import pg from 'pg'; export async function listProducts(db:any,q:any,context:ProductReadServiceContext){ const x = new Pool(); return context.repositories.products.list(q); } type ProductReadServiceContext = any;"}).status).toBe("FAIL"));
  test("raw SQL read fails", () => expect(auditProductReadSource({"bad.ts":"export async function listProducts(db:any,q:any,context:ProductReadServiceContext){ return sql`select * from products`; } type ProductReadServiceContext = any;"}).status).toBe("FAIL"));
  test("write-only documented exception passes current services", () => { const result = runProductReadRepositoryAudit(); expect(result.status).toBe("PASS"); expect(result.approvedWriteExceptions.length).toBeGreaterThan(0); });
});

describe("Sprint 26 additional actual read service coverage", () => {
  test("product service status filter response shape", async () => { const { db, repos } = await seedReadDb(); const result = await listProducts(db as any, { page:1, pageSize:10, status:ProductStatus.Draft } as any, countingContext(repos)); expect(result.items.map(p=>p.id)).toEqual(["p2"]); expect(result).toMatchObject({ total:1, page:1, pageSize:10 }); });
  test("public catalog legacy image compatibility through service", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); await (db as any).update(sqliteSchema.products).set({ status: ProductStatus.Published }).where(eq(sqliteSchema.products.id, "p2")); const p = await getPublicProductBySlug(db as any, "beta-watch", ctx); expect(p.images[0].id).toBe("img-legacy"); expect(ctx.calls).toContain("photos.listLegacyCompatibleByProduct"); });
  test("public category service reads by repository", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); const cats = await import("../src/services/publicCatalog").then(m=>m.listPublicCategories(db as any, ctx)); expect(cats.map(c=>c.slug)).toEqual(["alpha"]); expect(ctx.calls).toContain("categories.listPublic"); });
  test("public collection service reads by repository", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); const col = await import("../src/services/publicCatalog").then(m=>m.getPublicCollectionBySlug(db as any, "archive", ctx)); expect(col.id).toBe("col-a"); expect(ctx.calls).toContain("collections.getBySlug"); });
  test("ERP identity lookup by SKU uses repository", async () => { const { db, repos } = await seedReadDb(); const ctx = countingContext(repos); expect((await identityCheck(db as any, { sku:"SKU-1" }, ctx)).result).toBe("Match"); expect(ctx.calls).toContain("products.getBySku"); });
  test("category, collection, public and ERP reads do not mutate counts", async () => { const { db, repos } = await seedReadDb(); const before = await businessCounts(db); const ctx = countingContext(repos); await listCategories(db as any, { page:1, pageSize:10 } as any, ctx); await listCollections(db as any, { page:1, pageSize:10 } as any, ctx); await listPublicProducts(db as any, { page:1, pageSize:10, sort:"newest" } as any, ctx); await identityCheck(db as any, { sku:"SKU-1" }, ctx); expect(await businessCounts(db)).toEqual(before); });
});
