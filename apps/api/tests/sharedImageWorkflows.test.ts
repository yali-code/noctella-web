import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { AdminRole, AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";
const root=mkdtempSync(path.join(os.tmpdir(),"noctella-shared-images-"));
Object.assign(process.env,{ DATABASE_URL:":memory:", PRODUCT_PHOTO_DISK_STAGING_ENABLED:"true", PRODUCT_PHOTO_DIR:path.join(root,"photos"), AI_INTAKE_PHOTO_DIR:path.join(root,"intake"), MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,4).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET:"synthetic-state", ADMIN_APP_ORIGIN:"http://localhost:3001", STOREFRONT_APP_ORIGIN:"http://localhost:3000", SCHEDULER_AUTH_TOKEN:"synthetic-scheduler" });
let app: import("express").Express, db:any, cookie:string, actorId:string, categoryId:string, intakeId:string, intakePhotoId:string, resultProductId:string, productId:string, bytes:Buffer;
let gate: (typeof import("../src/services/photoUploadAdmission"))["imageProcessingAdmission"];
const origin="https://api.synthetic.test", env={INSTAGRAM_MEDIA_ALLOWED_HOSTS:"api.synthetic.test"};
async function product(sku:string){
 return (await import("../src/services/products")).createProduct(db,{sku,title:"Synthetic "+sku,type:ProductType.UniqueItem,status:ProductStatus.Draft,categoryId,priceEur:10,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false});
}
beforeAll(async()=>{
 app=(await import("../src/app")).default;db=(await import("../src/db/client")).db;
 gate=(await import("../src/services/photoUploadAdmission")).imageProcessingAdmission;
 const actor=await (await import("../src/services/adminAuth")).createAdminUser(db,{email:"shared@synthetic.test",role:AdminRole.Owner,password:"synthetic-password-123"});actorId=actor.id;
 const login=await request(app).post("/api/auth/login").send({email:"shared@synthetic.test",password:"synthetic-password-123"});
 cookie=String(login.headers["set-cookie"][0]).split(";")[0];
 categoryId=(await (await import("../src/services/categories")).createCategory(db,{name:"Synthetic",displayOrder:0,isActive:true})).id;
 productId=(await product("SHARED-PRODUCT")).id;resultProductId=(await product("SHARED-AI")).id;
 bytes=await sharp({create:{width:1600,height:1200,channels:3,background:"#a09060"}}).jpeg().withMetadata({orientation:6}).toBuffer();
 await mkdir(path.join(root,"photos"),{recursive:true});
 await writeFile(path.join(root,"photos","source.webp"),await sharp(bytes).webp().toBuffer());
},30000);
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await (await import("../src/db/client")).dbRuntime.shutdown();await rm(root,{recursive:true,force:true,maxRetries:3});});
it("stages AI HTTP ingress privately and preserves server actor, filename and source",async()=>{
 const intake=await request(app).post("/api/ai-product-intakes").set("Cookie",cookie).send({});
 expect(intake.status).toBe(201);intakeId=intake.body.id;
 const url="/api/ai-product-intakes/"+intakeId+"/photos";
 expect((await request(app).post(url).attach("photo",bytes,"Front.JPG")).status).toBe(401);
 const uploaded=await request(app).post(url).set("Cookie",cookie).attach("photo",bytes,"Front.JPG");
 expect(uploaded.status).toBe(201);
 expect(uploaded.body).toMatchObject({originalFilename:"Front.JPG",createdByAdminUserId:actorId,intakeId});
 intakePhotoId=uploaded.body.id;
 expect(await readdir(path.join(root,".ai-intake-upload-ingress"))).toEqual([]);
 expect(await readFile(path.join(root,"intake",uploaded.body.storageKey))).not.toEqual(bytes);
 const {aiProductIntakes}=await import("../src/db/schema");
 await db.update(aiProductIntakes).set({status:AiProductIntakeStatus.Applied,resultProductId}).where(eq(aiProductIntakes.id,intakeId));
});
it("serializes actual product HTTP, deterministic AI finalization and Instagram native calls",async()=>{
 let active=0,maximum=0,calls=0;
 for(const name of ["metadata","toFile","toBuffer"] as const){
  const original=(sharp.prototype as any)[name];
  vi.spyOn(sharp.prototype as any,name).mockImplementation(function(this:any,...args:any[]){
   active++;maximum=Math.max(maximum,active);calls++;
   return Promise.resolve(original.apply(this,args)).then(async value=>{await new Promise(r=>setTimeout(r,15));return value;}).finally(()=>active--);
  });
 }
 const {finalizeAiIntakePhotos}=await import("../src/services/aiIntakePhotoFinalization");
 const {prepareInstagramImageAsset,inspectPreparedInstagramImage}=await import("../src/integrations/instagram/mediaPreparation");
 const [uploaded,finalized,prepared]=await Promise.all([
  request(app).post("/api/products/"+productId+"/photos").set("Cookie",cookie).field("altText","Front").attach("photo",bytes,"photo.jpg"),
  finalizeAiIntakePhotos(db,intakeId,{},actorId),
  prepareInstagramImageAsset({url:"/images/product-photos/source.webp"},origin,env,path.join(root,"photos")),
 ]);
 expect(uploaded.status).toBe(201);expect(uploaded.body.altText).toBe("Front");
 expect(finalized.created).toBe(true);expect(finalized.product.photos[0].id).toBe(intakePhotoId);
 expect(maximum).toBe(1);expect(calls).toBeGreaterThanOrEqual(10);expect(active).toBe(0);
 expect(await inspectPreparedInstagramImage({url:"/images/product-photos/source.webp"},prepared,path.join(root,"photos"))).toBe(true);
 expect(await readdir(path.join(root,".product-photo-upload-staging"))).toEqual([]);
 expect(gate.snapshot()).toMatchObject({held:0,active:0,waiting:0});
 const {productPhotos,outboxEvents}=await import("../src/db/schema");
 expect(await db.select().from(productPhotos)).toHaveLength(2);expect(await db.select().from(outboxEvents)).toHaveLength(2);
});
it("already-finalized retries skip admission and reads; Instagram overload is retryable",async()=>{
 const {finalizeAiIntakePhotos}=await import("../src/services/aiIntakePhotoFinalization");
 const reader=await import("../src/ai-intake/photoReader");
 const read=vi.spyOn(reader.LocalAiIntakePhotoReader.prototype,"read");
 const leases=[gate.reserve(),gate.reserve(),gate.reserve()];
 try{
  expect((await finalizeAiIntakePhotos(db,intakeId,{},actorId)).created).toBe(false);expect(read).not.toHaveBeenCalled();
  await expect((await import("../src/integrations/instagram/mediaPreparation")).prepareInstagramImageAsset({url:"/images/product-photos/source.webp"},origin,env,path.join(root,"photos"))).rejects.toMatchObject({kind:"processing",retryable:true});
 }finally{leases.forEach(lease=>lease.release());}
});
it("failed AI native output removes only its exclusively owned partial file",async()=>{
 const privateRoot=path.join(root,"fault");await mkdir(privateRoot);await writeFile(path.join(privateRoot,"existing.webp"),"existing");
 vi.spyOn(sharp.prototype,"toFile").mockImplementationOnce((async(destination:string)=>{await writeFile(destination,"partial");throw Object.assign(Error("disk"),{code:"ENOSPC"});}) as any);
 const {LocalAiIntakePhotoStorage}=await import("../src/services/aiIntakePhotoStorage");
 await expect(new LocalAiIntakePhotoStorage(privateRoot).saveIntakePhoto({buffer:bytes,mimetype:"image/jpeg",size:bytes.length})).rejects.toMatchObject({code:"ENOSPC"});
 expect(await readdir(privateRoot)).toEqual(["existing.webp"]);expect(gate.snapshot().active).toBe(0);
});
it("flag OFF preserves real legacy storage and Instagram work even after admission closes",async()=>{
 process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED="false";gate.close();
 const {LocalAiIntakePhotoStorage}=await import("../src/services/aiIntakePhotoStorage");
 await expect(new LocalAiIntakePhotoStorage(path.join(root,"flag-off")).saveIntakePhoto({buffer:bytes,mimetype:"image/jpeg",size:bytes.length})).resolves.toHaveProperty("storageKey");
 const {LocalPhotoStorage}=await import("../src/services/photoStorage");
 await expect(new LocalPhotoStorage().saveProductPhoto({buffer:bytes,mimetype:"image/jpeg",size:bytes.length})).resolves.toHaveProperty("filename");
 await expect((await import("../src/integrations/instagram/mediaPreparation")).prepareInstagramImageAsset({url:"/images/product-photos/source.webp"},origin,env,path.join(root,"photos"))).resolves.toHaveProperty("url");
 expect(gate.snapshot()).toMatchObject({held:0,active:0,closed:true});
});
