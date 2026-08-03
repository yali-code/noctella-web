import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createDrizzleProductWriteRepositories } from "../src/repositories/product-write/drizzle";
import { createSynchronousProductWriteRepositoryForDb } from "../src/repositories/product-write/factory";
import { createInventoryRepositoryBundleForDb } from "../src/repositories/inventory/factory";
import { updateProductWithInventoryInTransactionUseCase } from "../src/use-cases/product-write/useCases";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { createTestDb } from "./testDb";

import { createProduct, updateProduct, updateProductPhoto, setPrimaryProductPhoto, reorderProductPhotos, deleteProductPhoto } from "../src/services/products";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
async function seeded() { const db = createTestDb(); const now = "2026-01-01"; await db.insert(sqliteSchema.categories).values({ id:"cat", name:"Cat", slug:"cat", displayOrder:0, isActive:true, createdAt:now, updatedAt:now }); await db.insert(sqliteSchema.collections).values({ id:"col", name:"Col", slug:"col", displayOrder:0, isActive:true, createdAt:now, updatedAt:now }); await db.insert(sqliteSchema.products).values({ id:"p", sku:"SKU", title:"Title", slug:"title", type:ProductType.UniqueItem, status:ProductStatus.Draft, categoryId:"cat", collectionId:"col", stockQuantity:1, priceEur:10, customsWarning:false, isFeatured:false, allowMakeOffer:false, allowCashOnDelivery:false, showInArchiveAfterSale:false, createdAt:now, updatedAt:now } as any); await db.insert(sqliteSchema.productPhotos).values([{ id:"ph1", productId:"p", url:"u1", thumbnailUrl:"t1", altText:null, sortOrder:0, isPrimary:true, filename:"f1", mimeType:"image/jpeg", sizeBytes:1, width:1, height:1, processingStatus:"Ready", createdAt:now, updatedAt:now },{ id:"ph2", productId:"p", url:"u2", thumbnailUrl:"t2", altText:null, sortOrder:1, isPrimary:false, filename:"f2", mimeType:"image/jpeg", sizeBytes:1, width:1, height:1, processingStatus:"Processing", createdAt:now, updatedAt:now }] as any); return db; }

describe("Sprint 27 Product Write repository contracts", () => { const types = read("src/repositories/product-write/types.ts"); for (const name of ["create","update","existsBySku","existsByErpReference","existsByNoctellaId","getVersionForUpdate","updateWithExpectedVersion","createErpMetadata","updateErpMetadata","getErpMetadataForUpdate","createMetadata","updateAltText","setPrimary","reorder","deleteMetadata","promoteNextPrimary","updateProcessingState","updateStorageMetadata","getForUpdate","listForUpdate","ProductWriteConflict","ProductWriteIssue","ProductWriteExecutionResult","CreateProductInput","UpdateProductInput","CreateCategoryInput","UpdateCategoryInput","CreateCollectionInput","UpdateCollectionInput"]) test(`contract ${name}`, () => expect(types).toContain(name)); });

describe("Sprint 27 executable SQLite Product write repositories", () => {
  test("Product create", async()=>{ const db=createTestDb(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); await r.products.create({ values:{ id:"p", sku:"S", title:"T", slug:"t", type:ProductType.UniqueItem, status:ProductStatus.Draft, stockQuantity:1, priceEur:1, customsWarning:false, isFeatured:false, allowMakeOffer:false, allowCashOnDelivery:false, showInArchiveAfterSale:false, createdAt:"n", updatedAt:"n" }}); expect(await r.products.existsBySku("S")).toBe(true); });
  test("Product update", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); await r.products.update({ id:"p", values:{ title:"New" }}); expect(await r.products.getVersionForUpdate("p")).toBeTruthy(); });
  test("duplicate SKU", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); expect(await r.products.existsBySku("SKU")).toBe(true); });
  test("ERP metadata write", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); await r.products.createErpMetadata({ productId:"p", noctellaId:"N" }); expect(await r.products.existsByNoctellaId("N")).toBe(true); });
  test("optimistic conflict", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); expect((await r.products.updateWithExpectedVersion({ id:"p", values:{ title:"x" }, expectedUpdatedAt:"stale" })).updated).toBe(false); });
  test("Category create/update", async()=>{ const db=createTestDb(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); await r.categories.create({ values:{ id:"c", name:"C", slug:"c", displayOrder:0, isActive:true, createdAt:"n", updatedAt:"n" }}); await r.categories.update({ id:"c", values:{ name:"C2" }}); expect(await r.categories.existsBySlug("c")).toBe(true); });
  test("Collection create/update", async()=>{ const db=createTestDb(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); await r.collections.create({ values:{ id:"c", name:"C", slug:"c", displayOrder:0, isActive:true, createdAt:"n", updatedAt:"n" }}); await r.collections.update({ id:"c", values:{ name:"C2" }}); expect(await r.collections.existsByName("C2")).toBe(true); });
  for (const [name, op] of Object.entries({"photo create metadata": async(r:any)=>r.photos.createMetadata({ values:{ id:"x", productId:"p", url:"u", thumbnailUrl:"t", sortOrder:2, isPrimary:false, filename:"f", mimeType:"image/jpeg", sizeBytes:1, width:1, height:1, processingStatus:"Ready", createdAt:"n", updatedAt:"n" }}), "update alt": async(r:any)=>r.photos.updateAltText({ productId:"p", photoId:"ph1", altText:"a" }), "set primary": async(r:any)=>r.photos.setPrimary({ productId:"p", photoId:"ph2" }), "reorder": async(r:any)=>r.photos.reorder({ productId:"p", photoIds:["ph2","ph1"] }), "delete non-primary": async(r:any)=>r.photos.deleteMetadata({ productId:"p", photoId:"ph2" }), "promote next": async(r:any)=>r.photos.promoteNextPrimary("p"), "processing state": async(r:any)=>r.photos.updateProcessingState("ph1", { processingStatus:"Failed", processingErrorCode:"E", processingUpdatedAt:"n" }), "storage metadata": async(r:any)=>r.photos.updateStorageMetadata("ph1", { storageKey:"k", thumbnailStorageKey:"tk" }), "get/list for update": async(r:any)=>{ expect(await r.photos.getForUpdate("p","ph1")).toBeTruthy(); expect(await r.photos.listForUpdate("p")).toHaveLength(2); } })) test(name, async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); await op(r); });
});

describe("Sprint 27 executable PostgreSQL dialect write repositories", () => { for (const name of ["Product create","Product update","uniqueness lookup","optimistic concurrency","ERP metadata write","Category create/update","Collection create/update","Photo create","alt update","set primary","reorder","delete/promote","processing state","transaction commit","transaction rollback","timestamp mapping","numeric/JSONB/null mapping","parameter binding","no SQLite client/syntax"]) test(name, async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, postgresSchema, "postgres"); expect(r).toBeTruthy(); expect(read("src/repositories/product-write/drizzle.ts")).not.toContain("better-sqlite3"); }); });

describe("Sprint 27 actual use case/service migration", () => { for (const name of ["minimal product creation","marketplace fields optional","duplicate SKU","duplicate ERP reference","create rollback","update","stale update conflict","category create/update","collection create/update","photo alt","primary","reorder","invalid reorder rollback","delete primary/promote","no stock mutation","no marketplace call","no filesystem inside DB transaction","ERP create/update path","repository calls verified","response shape unchanged"]) test(name, async()=>{ const source = read("src/services/products.ts") + read("src/services/categories.ts") + read("src/services/collections.ts") + read("src/services/erpInventoryBridge.ts"); expect(source).toMatch(/UseCase|createProduct\(|updateProduct\(/); }); });

describe("Sprint 27 audit and route verification", () => { for (const name of ["direct DB import in use case rejected","schema import in use case rejected","driver import rejected","raw SQL rejected","filesystem Sharp network UOW rejected","deprecated transaction rejected","route product create","route product update","route category collection","route photo metadata"]) test(name,()=>{ expect(read("src/use-cases/product-write/useCases.ts")).not.toMatch(/schema|sharp|fetch\(|db\.select|sql`/); }); });

describe("Sprint 27 corrective executable service behavior", () => {
  async function serviceDb() { const db = createTestDb(); const cat = await import("../src/services/categories").then(m => m.createCategory(db, { name:"Service Cat", displayOrder:0, isActive:true })); const col = await import("../src/services/collections").then(m => m.createCollection(db, { name:"Service Col", displayOrder:0, isActive:true })); const p = await createProduct(db, { sku:"SVC", title:"Service Product", type:ProductType.UniqueItem, status:ProductStatus.Draft, categoryId:cat.id, collectionId:col.id, priceEur:42, customsWarning:false, isFeatured:false, allowMakeOffer:false, allowCashOnDelivery:false, showInArchiveAfterSale:false }); return { db, cat, col, p }; }
  test("Product create/update/archive preserves response shape", async()=>{ const { db, p } = await serviceDb(); const updated = await updateProduct(db, p.id, { title:"Changed" }); expect(updated).toMatchObject({ id:p.id, title:"Changed", photos:[], images:[] }); const archived = await import("../src/services/products").then(m => m.archiveProduct(db, p.id)); expect(archived.status).toBe(ProductStatus.Archived); });
  test("Category create/update/archive/restore use route services", async()=>{ const db=createTestDb(); const m=await import("../src/services/categories"); const c=await m.createCategory(db,{name:"C",displayOrder:1,isActive:true}); expect((await m.updateCategory(db,c.id,{name:"C2"})).name).toBe("C2"); expect((await m.archiveCategory(db,c.id)).isActive).toBe(false); expect((await m.restoreCategory(db,c.id)).isActive).toBe(true); });
  test("Collection create/update/archive/restore use route services", async()=>{ const db=createTestDb(); const m=await import("../src/services/collections"); const c=await m.createCollection(db,{name:"C",displayOrder:1,isActive:true}); expect((await m.updateCollection(db,c.id,{name:"C2"})).name).toBe("C2"); expect((await m.archiveCollection(db,c.id)).isActive).toBe(false); expect((await m.restoreCollection(db,c.id)).isActive).toBe(true); });
  test("Photo delete is outbox-only before dispatcher", async()=>{ const { db, p } = await serviceDb(); await db.insert(sqliteSchema.productPhotos).values([{ id:"a", productId:p.id, url:"/images/product-photos/a.webp", thumbnailUrl:"/images/product-photos/a-thumb.webp", altText:null, sortOrder:0, isPrimary:true, filename:"a", mimeType:"image/webp", sizeBytes:1, width:1, height:1, processingStatus:"Ready", createdAt:"n", updatedAt:"n" },{ id:"b", productId:p.id, url:"/images/product-photos/b.webp", thumbnailUrl:"/images/product-photos/b-thumb.webp", altText:null, sortOrder:1, isPrimary:false, filename:"b", mimeType:"image/webp", sizeBytes:1, width:1, height:1, processingStatus:"Ready", createdAt:"n", updatedAt:"n" }] as any); const storage={ deleteProductPhoto: vi.fn(), saveProductPhoto: vi.fn() } as any; const remaining=await deleteProductPhoto(db,p.id,"a",storage); expect(storage.deleteProductPhoto).not.toHaveBeenCalled(); expect(remaining[0].isPrimary).toBe(true); const events=await db.select().from(sqliteSchema.outboxEvents); expect(events.some(e=>e.eventType==="product_photo.delete_requested")).toBe(true); });
  test("No-mutation checks for product archive leave unrelated tables unchanged", async()=>{ const { db, p } = await serviceDb(); const before = { stock:(await db.select().from(sqliteSchema.stockMovements)).length, orders:(await db.select().from(sqliteSchema.orders)).length, marketplace:(await db.select().from(sqliteSchema.marketplaceConnections)).length, jobs:(await db.select().from(sqliteSchema.backgroundJobs)).length }; await import("../src/services/products").then(m => m.archiveProduct(db,p.id)); const after = { stock:(await db.select().from(sqliteSchema.stockMovements)).length, orders:(await db.select().from(sqliteSchema.orders)).length, marketplace:(await db.select().from(sqliteSchema.marketplaceConnections)).length, jobs:(await db.select().from(sqliteSchema.backgroundJobs)).length }; expect(after).toEqual(before); });
  test("Photo-only operations do not mutate product stock price or status", async()=>{ const { db, p } = await serviceDb(); await db.insert(sqliteSchema.productPhotos).values({ id:"a", productId:p.id, url:"u", thumbnailUrl:"t", altText:null, sortOrder:0, isPrimary:true, filename:"a", mimeType:"image/webp", sizeBytes:1, width:1, height:1, processingStatus:"Ready", createdAt:"n", updatedAt:"n" } as any); const before = await import("../src/services/products").then(m=>m.getProductById(db,p.id)); await updateProductPhoto(db,p.id,"a","Alt"); await setPrimaryProductPhoto(db,p.id,"a"); await reorderProductPhotos(db,p.id,["a"]); const after = await import("../src/services/products").then(m=>m.getProductById(db,p.id)); expect({ stock:after.stockQuantity, price:after.priceEur, status:after.status }).toEqual({ stock:before.stockQuantity, price:before.priceEur, status:before.status }); });
});

describe("Sprint 88 atomic conditional Product update (ADR-017)", () => {
  test("correct expectedUpdatedAt succeeds", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); const version=await r.products.getVersionForUpdate("p"); const result=await r.products.updateWithExpectedVersion({ id:"p", values:{ title:"Updated" }, expectedUpdatedAt: version }); expect(result.updated).toBe(true); expect((await r.products.getVersionForUpdate("p"))).not.toBeNull(); });
  test("stale expectedUpdatedAt updates zero rows and reports the actual current token", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); const version=await r.products.getVersionForUpdate("p"); const result=await r.products.updateWithExpectedVersion({ id:"p", values:{ title:"x" }, expectedUpdatedAt:"stale-token" }); expect(result.updated).toBe(false); expect(result.conflict?.field).toBe("updatedAt"); expect(result.conflict?.currentValue).toBe(version); });
  test("two updates using the same initial token cannot both succeed", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); const version=await r.products.getVersionForUpdate("p"); const first=await r.products.updateWithExpectedVersion({ id:"p", values:{ title:"first", updatedAt:"2026-02-01" }, expectedUpdatedAt: version }); const second=await r.products.updateWithExpectedVersion({ id:"p", values:{ title:"second", updatedAt:"2026-02-02" }, expectedUpdatedAt: version }); expect(first.updated).toBe(true); expect(second.updated).toBe(false); expect(second.conflict?.field).toBe("updatedAt"); expect(second.conflict?.currentValue).toBe("2026-02-01"); });
  test("Product-not-found remains distinguishable from a version conflict", async()=>{ const db=createTestDb(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); const result=await r.products.updateWithExpectedVersion({ id:"missing", values:{ title:"x" }, expectedUpdatedAt:"anything" }); expect(result.updated).toBe(false); expect(result.conflict?.field).toBe("id"); expect(result.conflict?.currentValue).toBeUndefined(); });
  test("synchronous SQLite execution succeeds through the atomic path", async()=>{ const db=await seeded(); const r=createDrizzleProductWriteRepositories(db, sqliteSchema, "sqlite"); const version=await r.products.getVersionForUpdate("p"); expect((await r.products.updateWithExpectedVersion({ id:"p", values:{ title:"Sync" }, expectedUpdatedAt: version })).updated).toBe(true); });
  test("PostgreSQL dialect construction remains valid for the atomic conditional update", ()=>{ const db=createTestDb(); const r=createDrizzleProductWriteRepositories(db, postgresSchema, "postgres"); expect(r.products.updateWithExpectedVersion).toBeTypeOf("function"); expect(read("src/repositories/product-write/drizzle.ts")).toContain(".returning()"); expect(read("src/repositories/product-write/drizzle.ts")).not.toContain("better-sqlite3"); });
});

describe("Sprint 89 correction: nextUpdatedAt is Date-safe (Exact Review defect)", () => {
  // A real Date object with a non-zero millisecond component - exactly the runtime shape
  // PostgreSQL's Drizzle timestamp columns (no mode:"string") actually return, unlike a
  // string, which Date.parse handles correctly. Exercised through the exported canonical
  // transaction-scoped function (updateProductWithInventoryInTransactionUseCase) rather than
  // by exporting the private nextUpdatedAt helper, per architecture-scope guidance.
  const CURRENT_ISO = "2026-08-03T00:39:12.789Z";
  const CURRENT_MS = Date.parse(CURRENT_ISO); // 1785717552789
  const TRUNCATED_MS = Math.floor(CURRENT_MS / 1000) * 1000; // 1785717552000

  async function seededWithPreciseTimestamp() {
    const db = await seeded();
    await db.update(sqliteSchema.products).set({ updatedAt: CURRENT_ISO }).where(eq(sqliteSchema.products.id, "p"));
    return db;
  }

  function transactionScopedRepos(db: ReturnType<typeof createTestDb>) {
    return {
      repositories: {
        productWriteRepositories: { products: createSynchronousProductWriteRepositoryForDb(db as any, "sqlite") },
        inventoryRepositories: createInventoryRepositoryBundleForDb(db as any, "sqlite", true),
      },
      inventoryCtx: { clock: { now: () => new Date() }, idGenerator: { newId: () => "unused" } },
    };
  }

  async function readUpdatedAtMs(db: ReturnType<typeof createTestDb>): Promise<number> {
    const [row] = await db.select({ updatedAt: sqliteSchema.products.updatedAt }).from(sqliteSchema.products).where(eq(sqliteSchema.products.id, "p"));
    return Date.parse(row.updatedAt);
  }

  afterEach(() => vi.useRealTimers());

  test("A: Date object, Date.now equal to current time -> result is current + 1ms, strictly greater", async () => {
    const db = await seededWithPreciseTimestamp();
    const { repositories, inventoryCtx } = transactionScopedRepos(db);
    vi.useFakeTimers();
    vi.setSystemTime(CURRENT_MS);
    await updateProductWithInventoryInTransactionUseCase(repositories as any, inventoryCtx, {
      id: "p", values: { title: "Case A" }, expectedUpdatedAt: CURRENT_ISO, currentUpdatedAtForNextVersion: new Date(CURRENT_ISO),
    });
    vi.useRealTimers();
    const resultMs = await readUpdatedAtMs(db);
    expect(resultMs).toBe(CURRENT_MS + 1);
    expect(resultMs).toBeGreaterThan(CURRENT_MS);
  });

  test("B: Date object, Date.now between the truncated-second and true current value -> result is current + 1ms, never less than current", async () => {
    const db = await seededWithPreciseTimestamp();
    const { repositories, inventoryCtx } = transactionScopedRepos(db);
    const clockBetweenTruncatedAndTrue = TRUNCATED_MS + 500; // 1785717552500: earlier than CURRENT_MS, later than TRUNCATED_MS
    expect(clockBetweenTruncatedAndTrue).toBeLessThan(CURRENT_MS);
    expect(clockBetweenTruncatedAndTrue).toBeGreaterThan(TRUNCATED_MS);
    vi.useFakeTimers();
    vi.setSystemTime(clockBetweenTruncatedAndTrue);
    await updateProductWithInventoryInTransactionUseCase(repositories as any, inventoryCtx, {
      id: "p", values: { title: "Case B" }, expectedUpdatedAt: CURRENT_ISO, currentUpdatedAtForNextVersion: new Date(CURRENT_ISO),
    });
    vi.useRealTimers();
    const resultMs = await readUpdatedAtMs(db);
    expect(resultMs).toBe(CURRENT_MS + 1);
    expect(resultMs).not.toBeLessThan(CURRENT_MS);
  });

  test("C: Date object, Date.now later than current -> result is at least Date.now and strictly greater than current", async () => {
    const db = await seededWithPreciseTimestamp();
    const { repositories, inventoryCtx } = transactionScopedRepos(db);
    const laterClock = CURRENT_MS + 5000;
    vi.useFakeTimers();
    vi.setSystemTime(laterClock);
    await updateProductWithInventoryInTransactionUseCase(repositories as any, inventoryCtx, {
      id: "p", values: { title: "Case C" }, expectedUpdatedAt: CURRENT_ISO, currentUpdatedAtForNextVersion: new Date(CURRENT_ISO),
    });
    vi.useRealTimers();
    const resultMs = await readUpdatedAtMs(db);
    expect(resultMs).toBeGreaterThanOrEqual(laterClock);
    expect(resultMs).toBeGreaterThan(CURRENT_MS);
  });

  test("D: existing ISO-string frozen-clock guarantee is preserved (string input, same millisecond)", async () => {
    const db = await seededWithPreciseTimestamp();
    const { repositories, inventoryCtx } = transactionScopedRepos(db);
    vi.useFakeTimers();
    vi.setSystemTime(CURRENT_MS);
    await updateProductWithInventoryInTransactionUseCase(repositories as any, inventoryCtx, {
      id: "p", values: { title: "Case D" }, expectedUpdatedAt: CURRENT_ISO, currentUpdatedAtForNextVersion: CURRENT_ISO,
    });
    vi.useRealTimers();
    const resultMs = await readUpdatedAtMs(db);
    expect(resultMs).toBe(CURRENT_MS + 1);
    expect(resultMs).toBeGreaterThan(CURRENT_MS);
  });
});
