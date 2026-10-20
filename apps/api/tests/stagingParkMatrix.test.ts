/** Native unprivileged Linux tooling acceptance, real SQLite/PostgreSQL and process death. Not RC2 restart evidence. */
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {spawn, type ChildProcess} from "node:child_process";
import {sql,type SQL} from "drizzle-orm";
import sharp from "sharp";
import {createPostgresTestDb,postgresTestConfigured} from "./postgresTestDb";
const {root,launcher}=vi.hoisted(()=>{const fs=require("node:fs"),path=require("node:path"),os=require("node:os");const root=fs.mkdtempSync(path.join(os.tmpdir(),"f2-phase-matrix-"));const launcher=process.platform==="linux"?process.env.F2_CAPABILITY_LAUNCHER:undefined;Object.assign(process.env,{PRODUCT_PHOTO_DIR:path.join(root,"photos"),AI_INTAKE_PHOTO_DIR:path.join(root,"intake"),PHOTO_OWNERSHIP_FENCING_ENABLED:"true",PRODUCT_PHOTO_DISK_STAGING_ENABLED:"true",...(launcher?{PHOTO_PREPARATION_CONFINEMENT:"required",PHOTO_PREPARATION_LAUNCHER:launcher}:{})});return {root,launcher};});
import {uploadFencedProductPhoto} from "../src/services/w2FencedProductPhotoOwner";
import {digestW2StagedInput} from "../src/services/w2StagedInputDigest";
import {finalizeAiIntakePhotos} from "../src/services/aiIntakePhotoFinalization";
import {attestExecutorExit} from "../src/scripts/photoPublicationIntentRecovery";
vi.setConfig({testTimeout:120000,hookTimeout:120000});
const phases=["before-publication","after-main","after-both","committed-ack-loss"];
for(const driver of ["sqlite","postgres"] as const)describe("guarded park matrix "+driver,()=>{
 const enabled=!!launcher&&(driver==="sqlite"||postgresTestConfigured);
 let db:any,shutdown=async()=>{},url:string,category:string,actor:string,input:Buffer;
 const saved={driver:process.env.DATABASE_DRIVER,url:process.env.DATABASE_URL};
 const q=async(s:SQL):Promise<any[]>=>driver==="sqlite"?db.all(s):(await db.execute(s)).rows;
 beforeAll(async()=>{if(!enabled)return;
   if(driver==="sqlite"){url=path.join(root,"matrix.sqlite");const Database=(await import("better-sqlite3")).default;const raw=new Database(url);(await import("../src/db/migrate")).ensureSchema(raw);db=(await import("drizzle-orm/better-sqlite3")).drizzle(raw,{schema:await import("../src/db/schema.sqlite")});shutdown=async()=>raw.close();}
   else{const h=await createPostgresTestDb("0044_photo_publication_copies.sql");db=h.db;shutdown=()=>h.close();const u=new URL(process.env.POSTGRES_TEST_DATABASE_URL!);u.searchParams.set("options","-c search_path="+h.schemaName);url=u.toString();}
   process.env.DATABASE_DRIVER=driver;process.env.DATABASE_URL=url;
   category=randomUUID();actor=randomUUID();
   await q(sql`INSERT INTO categories (id,name,slug) VALUES (${category},'Synthetic',${category}) RETURNING id`);
   // Disposable native-test fixtures only; target setup always uses the supported review/stock APIs.
   actor="adminuser_"+actor;
   await q(sql`INSERT INTO admin_users (id,email,password_hash,role) VALUES (${actor},${actor+"@offline.test"},'unused-native-test-hash','owner') RETURNING id`);
   input=await sharp({create:{width:140,height:90,channels:3,background:"#805040"}}).jpeg().toBuffer();fs.writeFileSync(path.join(root,"input.jpg"),input);fs.mkdirSync(path.join(root,"intake"),{recursive:true});
 });
 afterAll(async()=>{await shutdown();for(const [key,value] of [["DATABASE_DRIVER",saved.driver],["DATABASE_URL",saved.url]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 for(const workflow of ["w2","w4"])for(const phase of phases)it.skipIf(!enabled)(workflow+" "+phase+": durable boundary, live refusal, interruption preservation and genuine death recovery",async()=>{
   const productId=randomUUID(),intakeId=randomUUID(),stagedId=randomUUID();
   await q(sql`INSERT INTO products (id,sku,title,slug,type,status,category_id) VALUES (${productId},${productId},${"F2 synthetic "+productId},${productId},'unique_item','draft',${category}) RETURNING id`);
   if(workflow==="w4"){
     await q(sql`INSERT INTO ai_product_intakes (id,status,created_by_admin_user_id,result_product_id,applied_at,applied_by_admin_user_id) VALUES (${intakeId},'applied',${actor},${productId},${new Date().toISOString()},${actor}) RETURNING id`);
     fs.writeFileSync(path.join(root,"intake",stagedId+".webp"),await sharp(input).webp({quality:85}).toBuffer());
     await q(sql`INSERT INTO ai_intake_photos (id,intake_id,storage_key,original_filename,created_by_admin_user_id) VALUES (${stagedId},${intakeId},${stagedId+".webp"},'synthetic.jpg',${actor}) RETURNING id`);
   }
   const env={...process.env,DATABASE_DRIVER:driver,DATABASE_URL:url,F2_STAGING_ACCEPTANCE:"enabled",F2_STAGING_SYNTHETIC_CASE:"confirmed",RENDER_SERVICE_ID:"srv-localmatrix01",F2_STAGING_TARGET_SERVICE_ID:"srv-localmatrix01"};
   const args=["w2"===workflow?productId:intakeId,actor,...(workflow==="w2"?[path.join(root,"input.jpg")]:[])];
   const controller:ChildProcess=spawn(process.execPath,[path.resolve(__dirname,"../../../scripts/photo-staging-acceptance/park-at-intent.mjs"),workflow,phase,...args],{cwd:path.resolve(__dirname,".."),env,stdio:["ignore","pipe","pipe"]});
   let parked:any,observedPid:number|undefined,log="",timer:any;
   try{
     parked=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error("park timeout: "+log)),60000);controller.stdout!.on("data",b=>{log+=b;for(const line of log.split("\n")){try{const m=JSON.parse(line);if(m.childPid)observedPid=m.childPid;if(m.event==="PARKED")resolve(m);if(/REFUSED|FAILED|TIMEOUT/.test(m.event))reject(Error(line));}catch(e){if(e instanceof SyntaxError)continue;reject(e);}}});controller.once("exit",()=>reject(Error("controller exited: "+log)));});clearTimeout(timer);
     expect(parked).toMatchObject({schema:1,workflow,phase,live:true,productId});expect(parked.operations).toHaveLength(1);
     const op=parked.operations[0];expect(op).toMatchObject({generation:"1",epoch:"1",scopeLive:true,state:phase==="committed-ack-loss"?"committed":"authorized"});expect(op.copies).toHaveLength(phase==="before-publication"?0:phase==="after-main"?1:2);
     const retry=async()=>{if(workflow==="w4")return finalizeAiIntakePhotos(db,intakeId,{},actor);const work=fs.mkdtempSync(path.join(root,"retry-"));const file={path:path.join(work,"input"),workDir:work,size:input.length,mimetype:"image/jpeg",signal:new AbortController().signal};fs.writeFileSync(file.path,input);return uploadFencedProductPhoto(db,{productId,actorId:actor,operationToken:parked.idempotencyKey,sha256:await digestW2StagedInput(file,92160),altText:"",file},{driver});};
     if(phase!=="committed-ack-loss"){await expect(retry()).rejects.toMatchObject({code:"PHOTO_OPERATION_IN_PROGRESS"});expect(await attestExecutorExit(db,driver,{operationId:op.operationId,epoch:1,executorIdentity:op.executorIdentity,operator:"test",evidence:"live negative"})).toMatchObject({recorded:false});}
     const before=await q(sql`SELECT state,executor_epoch FROM photo_publication_intents WHERE operation_id=${op.operationId}`);
     const inventory=()=>{const rows:any[]=[];const walk=(file:string)=>{if(!fs.existsSync(file))return;const st=fs.lstatSync(file,{bigint:true});if(st.isDirectory()){for(const n of fs.readdirSync(file).sort())walk(path.join(file,n));}else rows.push({key:path.relative(root,file),ino:String(st.ino),bytes:String(st.size),content:fs.readFileSync(file).toString("base64")});};for(const folder of [".product-photo-operations",".product-photo-publication"])walk(path.join(root,folder,op.operationId));for(const a of op.artifacts)walk(path.join(root,"photos",a.key));return rows;};const retained=inventory();
     controller.kill("SIGINT");await new Promise(r=>controller.once("exit",r));process.kill(parked.childPid,0);expect(inventory()).toEqual(retained);
     expect(await q(sql`SELECT state,executor_epoch FROM photo_publication_intents WHERE operation_id=${op.operationId}`)).toEqual(before);
     process.kill(parked.childPid,"SIGKILL");await new Promise(r=>setTimeout(r,200));
     const first=await retry(),second=await retry();expect(workflow==="w2"?(first as any).id:(first as any).product.photos[0].id).toBe(op.photoId);expect(workflow==="w2"?(second as any).id:(second as any).product.photos[0].id).toBe(op.photoId);
     const [final]=await q(sql`SELECT state,executor_epoch FROM photo_publication_intents WHERE operation_id=${op.operationId}`);expect(final.state).toBe("committed");expect(String(final.executor_epoch)).toBe(phase==="committed-ack-loss"?"1":"2");
     const [photo]=await q(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id=${op.photoId}`),[outbox]=await q(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id=${op.photoId}`);expect([Number(photo.n),Number(outbox.n)]).toEqual([1,1]);
     for(const a of op.artifacts){const current=await (await import("../src/services/ownedPhotoArtifactProof")).ownedPhotoArtifactProof(path.join(root,"photos",a.key),true);expect(current).toMatchObject({ino:a.ino,sha256:a.sha256,bytes:a.bytes});}
     const evidence=process.env.PHOTO_REMOUNT_EVIDENCE_DIR;if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,`guarded-${workflow}-${driver}-${phase}.json`),JSON.stringify({native:true,targetAcceptance:false,parked,final,photoCount:Number(photo.n),outboxCount:Number(outbox.n)},null,2));}
   }finally{clearTimeout(timer);controller.kill("SIGINT");if(observedPid)try{process.kill(observedPid,"SIGKILL");}catch{}}
 });
});
afterAll(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3}));
