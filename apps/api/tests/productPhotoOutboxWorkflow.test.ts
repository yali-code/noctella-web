import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { outboxEvents, productPhotos, products } from "../src/db/schema";
import { OutboxDispatcher, OutboxEventStatus, OutboxEventType } from "../src/services/outbox";
import { SqliteOutboxRepository } from "../src/services/outboxRepository";
import { ProductPhotoCleanupTempHandler, ProductPhotoDeleteHandler, ProductPhotoPromotionHandler, productPhotoStorageSafety } from "../src/services/productPhotoStorageWorkflow";
import { ProductPhotoProcessingStatus } from "../src/services/productPhotoOutboxWorkflow";
import { uploadProductPhoto, reorderProductPhotos, setPrimaryProductPhoto, updateProduct } from "../src/services/products";
import type { PhotoStorage } from "../src/services/photoStorage";
import { getPublicProductBySlug } from "../src/services/publicCatalog";
let sqlite:Database.Database; let db:any; let roots:string; let tempRoot:string; let permanentRoot:string; let sameRoot:string; let outbox:SqliteOutboxRepository;
const product={sku:"SKU-PP",title:"Photo Product",type:ProductType.UniqueItem,status:ProductStatus.Published,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false,priceEur:100};
function storage(fail=false):PhotoStorage{return {saveProductPhoto:vi.fn(async(file)=>{if(fail) throw new Error("temp failed"); return {filename:`main-${file.mimetype.split('/')[1]}.webp`,url:"/temp/main",thumbnailUrl:"/temp/thumb",mimeType:file.mimetype,sizeBytes:file.size,width:1,height:1};}),deleteProductPhoto:vi.fn(async()=>{})};}
async function createProduct(){const p={id:"p1",slug:"photo-product",...product}; await db.insert(products).values(p); return p;}
function uow(){return {run:async(fn:any)=>fn({repositories:{db}})};}
async function photoRow(){return (await db.select().from(productPhotos))[0];}
beforeEach(async()=>{sqlite=new Database(":memory:"); ensureSchema(sqlite); db=drizzle(sqlite,{schema}); outbox=new SqliteOutboxRepository(sqlite); roots=await fs.mkdtemp(path.join(os.tmpdir(),"noctella-photo-")); tempRoot=path.join(roots,"tmp"); permanentRoot=path.join(roots,"perm"); sameRoot=path.join(roots,"same"); await fs.mkdir(tempRoot,{recursive:true}); await fs.mkdir(permanentRoot,{recursive:true}); await fs.mkdir(sameRoot,{recursive:true});});
afterEach(async()=>{await fs.rm(roots,{recursive:true,force:true});});
describe("product photo outbox workflow",()=>{
 it.each(["image/jpeg","image/png","image/webp"])("accepts %s uploads and creates Processing photo",async(mime)=>{await createProduct(); const p=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:mime,size:1},undefined,storage()); expect(p.processingStatus).toBe(ProductPhotoProcessingStatus.Processing);});
 it("rejects unsupported MIME before DB write",async()=>{await createProduct(); const s=storage(true); await expect(uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/gif",size:1},undefined,s)).rejects.toThrow(); expect(await db.select().from(productPhotos)).toHaveLength(0);});
 it("rejects oversized input via preprocessing storage",async()=>{await createProduct(); await expect(uploadProductPhoto(db,"p1",{buffer:Buffer.alloc(1),mimetype:"image/png",size:11_000_000},undefined,storage(true))).rejects.toThrow();});
 it("cleans temp artifacts after DB failure",async()=>{await createProduct(); const s=storage(); sqlite.prepare("CREATE TRIGGER fail_photo_cleanup AFTER INSERT ON product_photos BEGIN SELECT RAISE(ABORT,'photo failed'); END;").run(); await expect(uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,s)).rejects.toThrow(); expect(s.deleteProductPhoto).toHaveBeenCalled();});
 it("creates Pending promotion outbox event",async()=>{await createProduct(); const p=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage()); const e=await outbox.findByIdempotencyKey(`product-photo-promote:${p.id}`); expect(e?.status).toBe(OutboxEventStatus.Pending);});
 it("photo and outbox commit atomically",async()=>{await createProduct(); await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage()); expect(await db.select().from(productPhotos)).toHaveLength(1); expect(await db.select().from(outboxEvents)).toHaveLength(1);});
 it("transaction failure leaves neither photo nor outbox",async()=>{sqlite.prepare("CREATE TRIGGER fail_outbox AFTER INSERT ON outbox_events BEGIN SELECT RAISE(ABORT,'outbox failed'); END;").run(); await createProduct(); await expect(uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage())).rejects.toThrow(); expect(await db.select().from(productPhotos)).toHaveLength(0); expect(await db.select().from(outboxEvents)).toHaveLength(0);});
 it("cleanup failure is redacted by dispatcher",async()=>{await outbox.create({id:"e",eventType:OutboxEventType.ProductPhotoCleanupTempRequested,aggregateType:"ProductPhoto",idempotencyKey:"c",payload:{storageKey:"../secret"},maxAttempts:1,availableAt:"2026-01-01"}); const d=new OutboxDispatcher(outbox); d.registerHandler(new ProductPhotoCleanupTempHandler({tempRoot,permanentRoot})); await d.dispatchDueEvents("w",1); expect((await outbox.getById("e"))?.lastErrorMessage).not.toContain(roots);});
 it("handler promotes main and thumbnail, marks Ready and deletes temp",async()=>{await createProduct(); await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage()); const ph=await photoRow(); await fs.writeFile(path.join(tempRoot,ph.storageKey),"main"); await fs.writeFile(path.join(tempRoot,ph.thumbnailStorageKey),"thumb"); await new ProductPhotoPromotionHandler(uow() as any,{tempRoot,permanentRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:ph.id,idempotencyKey:"k",payload:{photoId:ph.id},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""}); const ready=await photoRow(); expect(ready.processingStatus).toBe("Ready"); await expect(fs.access(path.join(permanentRoot,ph.storageKey))).resolves.toBeUndefined(); await expect(fs.access(path.join(tempRoot,ph.storageKey))).rejects.toThrow();});
 it("promotion handler is idempotent for Ready photo",async()=>{await createProduct(); await db.insert(productPhotos).values({id:"ph",productId:"p1",url:"/x",thumbnailUrl:"/t",sortOrder:0,isPrimary:true,filename:"x",mimeType:"image/png",sizeBytes:1,width:1,height:1,processingStatus:"Ready"}); await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot,permanentRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"ph",idempotencyKey:"k",payload:{photoId:"ph"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).resolves.toBeUndefined();});
 it("missing source file is handled idempotently",async()=>{await createProduct(); await db.insert(productPhotos).values({id:"ph",productId:"p1",url:"/x",thumbnailUrl:"/t",sortOrder:0,isPrimary:true,filename:"missing",mimeType:"image/png",sizeBytes:1,width:1,height:1,processingStatus:"Processing",storageKey:"missing",thumbnailStorageKey:"missing-thumb"}); await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot,permanentRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"ph",idempotencyKey:"k",payload:{photoId:"ph"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).resolves.toBeUndefined();});
 it("transient promotion failure retries",async()=>{await outbox.create({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",idempotencyKey:"k",payload:{photoId:"missing"},maxAttempts:2,availableAt:"2026-01-01"}); const d=new OutboxDispatcher(outbox,{maxAttempts:2,nextDelayMs:()=>1,isPermanent:()=>false}); d.registerHandler({eventType:OutboxEventType.ProductPhotoPromoteRequested,handle:async()=>{throw new Error("io")}}); await d.dispatchDueEvents("w",1); expect((await outbox.getById("e"))?.status).toBe(OutboxEventStatus.RetryPending);});
 it("permanent exhausted promotion failure dead-letters safely",async()=>{await outbox.create({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",idempotencyKey:"k",payload:{},maxAttempts:1,availableAt:"2026-01-01"}); const d=new OutboxDispatcher(outbox); d.registerHandler({eventType:OutboxEventType.ProductPhotoPromoteRequested,handle:async()=>{throw Object.assign(new Error("bad path /x/y"),{permanent:true,code:"BAD"})}}); await d.dispatchDueEvents("w",1); expect((await outbox.getById("e"))?.status).toBe(OutboxEventStatus.DeadLetter); expect((await outbox.getById("e"))?.lastErrorCode).toBe("BAD");});
 it("maintains one primary photo",async()=>{await createProduct(); const s=storage(); const a=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("a"),mimetype:"image/png",size:1},undefined,s); const b=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("b"),mimetype:"image/png",size:1},undefined,s); const photos=await setPrimaryProductPhoto(db,"p1",b.id); expect(photos.filter(p=>p.isPrimary)).toHaveLength(1); expect(photos.find(p=>p.id===b.id)?.isPrimary).toBe(true);});
 it("reorder is atomic and rollback safe",async()=>{await createProduct(); const s=storage(); const a=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("a"),mimetype:"image/png",size:1},undefined,s); await expect(reorderProductPhotos(db,"p1",[a.id,"missing"])).rejects.toThrow(); expect((await photoRow()).sortOrder).toBe(0);});
 it("delete creates durable cleanup event",async()=>{await createProduct(); const p=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("a"),mimetype:"image/png",size:1},undefined,storage()); const { deleteProductPhoto } = await import("../src/services/products"); await deleteProductPhoto(db,"p1",p.id,storage()); expect((await db.select().from(outboxEvents)).some((e:any)=>e.eventType===OutboxEventType.ProductPhotoDeleteRequested)).toBe(true);});
 it("local-file cleanup is idempotent",async()=>{await fs.writeFile(path.join(permanentRoot,"a"),"x"); const h=new ProductPhotoDeleteHandler({tempRoot,permanentRoot}); await h.handle({id:"e",eventType:OutboxEventType.ProductPhotoDeleteRequested,aggregateType:"ProductPhoto",idempotencyKey:"k",payload:{storageKey:"a"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:1,availableAt:"",createdAt:"",updatedAt:""}); await h.handle({id:"e",eventType:OutboxEventType.ProductPhotoDeleteRequested,aggregateType:"ProductPhoto",idempotencyKey:"k",payload:{storageKey:"a"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:1,availableAt:"",createdAt:"",updatedAt:""}); await expect(fs.access(path.join(permanentRoot,"a"))).rejects.toThrow();});
 it("external URL is never deleted",async()=>{const spy=vi.spyOn(fs,"unlink"); await new ProductPhotoDeleteHandler({tempRoot,permanentRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoDeleteRequested,aggregateType:"ProductPhoto",idempotencyKey:"k",payload:{url:"https://cdn.example/a.jpg"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:1,availableAt:"",createdAt:"",updatedAt:""}); expect(spy).not.toHaveBeenCalled(); spy.mockRestore();});
 it("path traversal is rejected",()=>{expect(()=>productPhotoStorageSafety.safeJoin(tempRoot,"../x")).toThrow();});
 it("does not mutate stock status or price",async()=>{await createProduct(); await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage()); const [p]=await db.select().from(products).where(eq(products.id,"p1")); expect(p.status).toBe(ProductStatus.Published); expect(p.priceEur).toBe(100); expect(p.stockQuantity).toBe(1);});
 it("public catalog includes Ready only and excludes Processing/Failed",async()=>{await createProduct(); await db.insert(productPhotos).values([{id:"r",productId:"p1",url:"/r",thumbnailUrl:"/rt",sortOrder:0,isPrimary:true,filename:"r",mimeType:"image/png",sizeBytes:1,width:1,height:1,processingStatus:"Ready"},{id:"f",productId:"p1",url:"/f",thumbnailUrl:"/ft",sortOrder:1,isPrimary:false,filename:"f",mimeType:"image/png",sizeBytes:1,width:1,height:1,processingStatus:"Failed"}]); const ready=await db.select().from(productPhotos).where(eq(productPhotos.processingStatus,"Ready")); expect(ready.map((p:any)=>p.id)).toEqual(["r"]);});
 it("legacy/external existing photos remain compatible as Ready",async()=>{await createProduct(); await db.insert(productPhotos).values({id:"legacy",productId:"p1",url:"https://cdn/1.jpg",thumbnailUrl:"https://cdn/t.jpg",sortOrder:0,isPrimary:true,filename:"legacy",mimeType:"image/jpeg",sizeBytes:1,width:1,height:1}); expect((await photoRow()).processingStatus).toBe("Ready");});
 it("admin projection includes retry eligibility and safe status",async()=>{const projection={processingStatus:"Failed",retryEligible:true,safeError:"PHOTO_STORAGE_PERMANENT"}; expect(projection).toMatchObject({processingStatus:"Failed",retryEligible:true});});
 it("failed photo can be marked with safe error code only",async()=>{await createProduct(); await db.insert(productPhotos).values({id:"ph",productId:"p1",url:"/x",thumbnailUrl:"/t",sortOrder:0,isPrimary:true,filename:"x",mimeType:"image/png",sizeBytes:1,width:1,height:1,processingStatus:"Failed",processingErrorCode:"PHOTO_STORAGE_PERMANENT"}); expect((await photoRow()).processingErrorCode).not.toContain("/");});
});

// Sprint 71: LocalPhotoStorage (the real, only implemented storage backend) writes uploads
// directly into the single directory that is also served publicly - tempRoot and permanentRoot
// resolve to the same physical directory in production. These tests exercise that same-root path
// directly, since the tests above only ever exercise the handler with two distinct directories.
describe("product photo promotion - same physical root (Sprint 71)",()=>{
 it("marks Ready without copying or deleting when tempRoot and permanentRoot are the same directory",async()=>{
   await createProduct();
   await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage());
   const ph=await photoRow();
   await fs.writeFile(path.join(sameRoot,ph.storageKey),"main");
   await fs.writeFile(path.join(sameRoot,ph.thumbnailStorageKey),"thumb");
   const copySpy=vi.spyOn(fs,"copyFile"); const unlinkSpy=vi.spyOn(fs,"unlink");
   await new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:ph.id,idempotencyKey:"k",payload:{photoId:ph.id},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""});
   expect(copySpy).not.toHaveBeenCalled(); expect(unlinkSpy).not.toHaveBeenCalled();
   copySpy.mockRestore(); unlinkSpy.mockRestore();
   const ready=await photoRow(); expect(ready.processingStatus).toBe("Ready");
   expect((await fs.readFile(path.join(sameRoot,ph.storageKey),"utf8"))).toBe("main");
   expect((await fs.readFile(path.join(sameRoot,ph.thumbnailStorageKey),"utf8"))).toBe("thumb");
 });
 it("does not mark Ready and leaves the event retryable when the main file is missing",async()=>{
   await createProduct();
   await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage());
   const ph=await photoRow();
   await fs.writeFile(path.join(sameRoot,ph.thumbnailStorageKey),"thumb");
   await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:ph.id,idempotencyKey:"k",payload:{photoId:ph.id},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).rejects.toMatchObject({permanent:false});
   expect((await photoRow()).processingStatus).toBe("Processing");
 });
 it("does not mark Ready and leaves the event retryable when the thumbnail file is missing",async()=>{
   await createProduct();
   await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage());
   const ph=await photoRow();
   await fs.writeFile(path.join(sameRoot,ph.storageKey),"main");
   await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"e",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:ph.id,idempotencyKey:"k",payload:{photoId:ph.id},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).rejects.toMatchObject({permanent:false});
   expect((await photoRow()).processingStatus).toBe("Processing");
 });
 it("dispatcher retries a missing-file event and succeeds once the file becomes available",async()=>{
   await createProduct();
   const p=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage());
   const ph=await photoRow();
   const d=new OutboxDispatcher(outbox,{maxAttempts:2,nextDelayMs:()=>0,isPermanent:()=>false});
   d.registerHandler(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}));
   await d.dispatchDueEvents("w",1);
   expect((await outbox.findByIdempotencyKey(`product-photo-promote:${p.id}`))?.status).toBe(OutboxEventStatus.RetryPending);
   expect((await photoRow()).processingStatus).toBe("Processing");
   await fs.writeFile(path.join(sameRoot,ph.storageKey),"main");
   await fs.writeFile(path.join(sameRoot,ph.thumbnailStorageKey),"thumb");
   await d.dispatchDueEvents("w",1);
   expect((await outbox.findByIdempotencyKey(`product-photo-promote:${p.id}`))?.status).toBe(OutboxEventStatus.Succeeded);
   expect((await photoRow()).processingStatus).toBe("Ready");
 });
 it("re-dispatching an already-promoted event is a no-op (idempotent)",async()=>{
   await createProduct();
   const p=await uploadProductPhoto(db,"p1",{buffer:Buffer.from("x"),mimetype:"image/png",size:1},undefined,storage());
   const ph=await photoRow();
   await fs.writeFile(path.join(sameRoot,ph.storageKey),"main");
   await fs.writeFile(path.join(sameRoot,ph.thumbnailStorageKey),"thumb");
   const d=new OutboxDispatcher(outbox);
   d.registerHandler(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}));
   await d.dispatchDueEvents("w",1);
   await d.dispatchDueEvents("w",1);
   expect((await photoRow()).processingStatus).toBe("Ready");
   expect((await outbox.findByIdempotencyKey(`product-photo-promote:${p.id}`))?.status).toBe(OutboxEventStatus.Succeeded);
 });
 it("delete event removes the physical file at the shared public root",async()=>{
   await fs.writeFile(path.join(sameRoot,"shared.webp"),"x");
   const h=new ProductPhotoDeleteHandler({tempRoot:sameRoot,permanentRoot:sameRoot});
   await h.handle({id:"e",eventType:OutboxEventType.ProductPhotoDeleteRequested,aggregateType:"ProductPhoto",idempotencyKey:"k",payload:{storageKey:"shared.webp"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:1,availableAt:"",createdAt:"",updatedAt:""});
   await expect(fs.access(path.join(sameRoot,"shared.webp"))).rejects.toThrow();
 });
});

// Sprint 71 correction: reproduces the REAL legacy HERMLE CLOCK state found in the actual local
// dev.sqlite - rows created before the products.ts key-derivation fix persisted
// thumbnailStorageKey as "<id>.webp-thumb" (which never matches the real "<id>-thumb.webp" file
// LocalPhotoStorage wrote), while thumbnailUrl always correctly pointed at the real file. The
// previous fixture in this file used an already-corrected key and did not prove recovery of the
// real malformed shape - these tests use the exact malformed shape instead.
describe("legacy malformed thumbnail-key recovery (Sprint 71 correction)",()=>{
 async function createLegacyProduct(){const p={id:"legacy-p1",slug:"hermle-clock",sku:"NOC-00001",title:"HERMLE CLOCK",type:ProductType.UniqueItem,status:ProductStatus.Published,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false,priceEur:100}; await db.insert(products).values(p); return p;}
 async function insertLegacyPhoto(overrides:Record<string,unknown> = {}){
   await db.insert(productPhotos).values({id:"hermle-photo",productId:"legacy-p1",url:"/images/product-photos/hermle.webp",thumbnailUrl:"/images/product-photos/hermle-thumb.webp",sortOrder:0,isPrimary:true,filename:"hermle.webp",mimeType:"image/webp",sizeBytes:1,width:10,height:10,processingStatus:"Processing",storageKey:"hermle.webp",thumbnailStorageKey:"hermle.webp-thumb",...overrides});
 }
 async function insertLegacyEvent(){
   await outbox.create({id:"legacy-event",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"hermle-photo",idempotencyKey:"product-photo-promote:hermle-photo",payload:{photoId:"hermle-photo",productId:"legacy-p1"},maxAttempts:3,availableAt:"2026-01-01T00:00:00.000Z"});
 }
 async function legacyPhotoRow(){const [row]=await db.select().from(productPhotos).where(eq(productPhotos.id,"hermle-photo")); return row;}

 it("recovers the real malformed legacy thumbnail key and succeeds on first dispatch",async()=>{
   await createLegacyProduct();
   await insertLegacyPhoto();
   await insertLegacyEvent();
   // The real file on disk uses the correct "<id>-thumb.webp" shape - no "hermle.webp-thumb" file
   // is ever created, matching the real local-data directory exactly.
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   await fs.writeFile(path.join(sameRoot,"hermle-thumb.webp"),"thumb");
   const copySpy=vi.spyOn(fs,"copyFile"); const unlinkSpy=vi.spyOn(fs,"unlink");
   const d=new OutboxDispatcher(outbox);
   d.registerHandler(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}));
   await d.dispatchDueEvents("w",10);
   expect(copySpy).not.toHaveBeenCalled(); expect(unlinkSpy).not.toHaveBeenCalled();
   copySpy.mockRestore(); unlinkSpy.mockRestore();

   // 1. Event succeeds rather than entering RetryPending or DeadLetter.
   expect((await outbox.getById("legacy-event"))?.status).toBe(OutboxEventStatus.Succeeded);
   // 2. processingStatus becomes Ready.
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Ready");
   // 3. thumbnailStorageKey is persisted as "hermle-thumb.webp".
   expect(row.thumbnailStorageKey).toBe("hermle-thumb.webp");
   // 4/5. The primary and thumbnail files still exist.
   await expect(fs.access(path.join(sameRoot,"hermle.webp"))).resolves.toBeUndefined();
   await expect(fs.access(path.join(sameRoot,"hermle-thumb.webp"))).resolves.toBeUndefined();

   // 8. A repeated dispatch is idempotent.
   await d.dispatchDueEvents("w",10);
   const rowAfterRedispatch=await legacyPhotoRow();
   expect(rowAfterRedispatch.processingStatus).toBe("Ready");
   expect(rowAfterRedispatch.thumbnailStorageKey).toBe("hermle-thumb.webp");
   await expect(fs.access(path.join(sameRoot,"hermle.webp"))).resolves.toBeUndefined();
   await expect(fs.access(path.join(sameRoot,"hermle-thumb.webp"))).resolves.toBeUndefined();

   // 9. Public product output includes the photo after recovery.
   const publicProduct=await getPublicProductBySlug(db,"hermle-clock");
   expect((publicProduct.photos ?? []).some((p:any)=>p.id==="hermle-photo")).toBe(true);
 });

 it("leaves the photo Processing and persists no corrected key when both the stored key and the derived candidate are missing",async()=>{
   await createLegacyProduct();
   await insertLegacyPhoto();
   await insertLegacyEvent();
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   // Neither "hermle.webp-thumb" (stored key) nor "hermle-thumb.webp" (derived candidate) exists.
   const d=new OutboxDispatcher(outbox,{maxAttempts:3,nextDelayMs:()=>0,isPermanent:()=>false});
   d.registerHandler(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}));
   await d.dispatchDueEvents("w",10);
   expect((await outbox.getById("legacy-event"))?.status).toBe(OutboxEventStatus.RetryPending);
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Processing");
   expect(row.thumbnailStorageKey).toBe("hermle.webp-thumb");
 });

 it("does not accept an external thumbnailUrl as a local recovery candidate",async()=>{
   await createLegacyProduct();
   await insertLegacyPhoto({thumbnailUrl:"https://cdn.example.com/hermle-thumb.webp"});
   await insertLegacyEvent();
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"legacy-event",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"hermle-photo",idempotencyKey:"k",payload:{photoId:"hermle-photo"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).rejects.toMatchObject({permanent:false});
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Processing");
   expect(row.thumbnailStorageKey).toBe("hermle.webp-thumb");
 });

 it("rejects a traversal-style thumbnailUrl as a recovery candidate",async()=>{
   await createLegacyProduct();
   await insertLegacyPhoto({thumbnailUrl:"/images/product-photos/.."});
   await insertLegacyEvent();
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"legacy-event",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"hermle-photo",idempotencyKey:"k",payload:{photoId:"hermle-photo"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).rejects.toMatchObject({permanent:false});
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Processing");
   expect(row.thumbnailStorageKey).toBe("hermle.webp-thumb");
 });

 // Sprint 71 path-safety correction: a bare "." segment must never resolve to PRODUCT_PHOTO_DIR
 // itself and be mistaken for an existing thumbnail file.
 it("rejects a thumbnailUrl ending in a bare '.' segment as a recovery candidate",async()=>{
   await createLegacyProduct();
   await insertLegacyPhoto({thumbnailUrl:"/images/product-photos/."});
   await insertLegacyEvent();
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"legacy-event",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"hermle-photo",idempotencyKey:"k",payload:{photoId:"hermle-photo"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).rejects.toMatchObject({permanent:false});
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Processing");
   expect(row.thumbnailStorageKey).toBe("hermle.webp-thumb");
 });

 it("rejects a thumbnailUrl that is exactly '.' as a recovery candidate",async()=>{
   await createLegacyProduct();
   await insertLegacyPhoto({thumbnailUrl:"."});
   await insertLegacyEvent();
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   await expect(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}).handle({id:"legacy-event",eventType:OutboxEventType.ProductPhotoPromoteRequested,aggregateType:"ProductPhoto",aggregateId:"hermle-photo",idempotencyKey:"k",payload:{photoId:"hermle-photo"},status:OutboxEventStatus.Processing,attemptCount:0,maxAttempts:3,availableAt:"",createdAt:"",updatedAt:""})).rejects.toMatchObject({permanent:false});
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Processing");
   expect(row.thumbnailStorageKey).toBe("hermle.webp-thumb");
 });

 it("does not accept a directory at the candidate thumbnail path as a thumbnail file",async()=>{
   await createLegacyProduct();
   // thumbnailUrl still points at the real, correct filename shape - but this time a directory
   // (not a file) happens to exist at that path, e.g. from a prior partial/corrupt write.
   await insertLegacyPhoto();
   await insertLegacyEvent();
   await fs.writeFile(path.join(sameRoot,"hermle.webp"),"main");
   await fs.mkdir(path.join(sameRoot,"hermle-thumb.webp"));
   const copySpy=vi.spyOn(fs,"copyFile"); const unlinkSpy=vi.spyOn(fs,"unlink");
   const d=new OutboxDispatcher(outbox,{maxAttempts:3,nextDelayMs:()=>0,isPermanent:()=>false});
   d.registerHandler(new ProductPhotoPromotionHandler(uow() as any,{tempRoot:sameRoot,permanentRoot:sameRoot}));
   await d.dispatchDueEvents("w",10);
   expect(copySpy).not.toHaveBeenCalled(); expect(unlinkSpy).not.toHaveBeenCalled();
   copySpy.mockRestore(); unlinkSpy.mockRestore();
   // The event follows the existing retry path rather than Succeeded.
   expect((await outbox.getById("legacy-event"))?.status).toBe(OutboxEventStatus.RetryPending);
   // The photo remains Processing.
   const row=await legacyPhotoRow();
   expect(row.processingStatus).toBe("Processing");
   // No corrected thumbnailStorageKey is persisted.
   expect(row.thumbnailStorageKey).toBe("hermle.webp-thumb");
 });
});
