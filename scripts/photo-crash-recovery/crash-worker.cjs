// Deterministic fault injection in REAL photo services. Never imported by runtime.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {createRequire}=require('node:module');
const Module=require('node:module');const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(name,...args){return originalResolve.call(this,name==='@noctella/shared'?path.resolve(__dirname,'../../packages/shared/dist/index.js'):name,...args);};
const api=createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const [root,driver,boundary,schemaName]=process.argv.slice(2);
if(!root||!path.resolve(root).startsWith(path.join(os.tmpdir(),'noctella-photo-crash-'))||!['sqlite','postgres'].includes(driver))throw Error('Disposable crash probe required');
if(fs.realpathSync(root)!==path.resolve(root))throw Error('Unsafe disposable root');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_DRIVER:driver,DATABASE_URL:driver==='sqlite'?path.join(root,'test.sqlite'):process.env.POSTGRES_TEST_DATABASE_URL,PRODUCT_PHOTO_DISK_STAGING_ENABLED:'true',PRODUCT_PHOTO_DIR:path.join(root,'canonical'),AI_INTAKE_PHOTO_DIR:path.join(root,'intake')});
const service=name=>require('../../apps/api/src/services/'+name+'.ts');
let stage='connect';let details={};const checkpoint=phase=>{const record={phase,boundary,driver,syntheticOnly:true,...details};fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify(record,null,2));fs.writeSync(1,JSON.stringify(record)+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);throw Error('Unexpected checkpoint return');};
(async()=>{
 let db,connection;
 const schema=require('../../apps/api/src/db/schema.'+(driver==='sqlite'?'sqlite':'postgres')+'.ts');
 if(driver==='sqlite') {const Database=api('better-sqlite3');connection=new Database(path.join(root,'test.sqlite'));connection.pragma('journal_mode = WAL');require('../../apps/api/src/db/migrate.ts').ensureSchema(connection);db=api('drizzle-orm/better-sqlite3').drizzle(connection,{schema});}
 else {require('../../apps/api/tests/postgresTestDb.ts').assertDisposablePostgresUrl(process.env.POSTGRES_TEST_DATABASE_URL);const u=new URL(process.env.POSTGRES_TEST_DATABASE_URL);if(!['localhost','127.0.0.1','::1'].includes(u.hostname)||!/^sprint151_test_[a-f0-9]+$/.test(schemaName))throw Error('Local disposable PostgreSQL only');const pg=api('pg');connection=new pg.Pool({connectionString:process.env.POSTGRES_TEST_DATABASE_URL,options:'-c search_path='+schemaName,max:2});db=api('drizzle-orm/node-postgres').drizzle(connection,{schema});}
 if(boundary.startsWith('pg-protocol-')){
  if(driver!=='postgres')throw Error('PostgreSQL fixture only');
  const processor=api('sharp');const canonical=path.join(root,'canonical');
  const workDir=path.join(root,'ai-ingress','request-protocol');fs.mkdirSync(workDir,{recursive:true,mode:0o700});const bytes=await processor({create:{width:32,height:24,channels:3,background:'#a08060'}}).png().toBuffer();fs.writeFileSync(path.join(workDir,'input'),bytes,{flag:'wx',mode:0o600});
  const staged={path:path.join(workDir,'input'),workDir,size:bytes.length,mimetype:'image/png',signal:new AbortController().signal};
  const privatePhoto=await new (service('aiIntakePhotoStorage').LocalAiIntakePhotoStorage)(path.join(root,'intake')).saveStagedIntakePhoto(staged);
  const stored=await new (service('stagedProductPhotoStorage').LocalStagedProductPhotoStorage)(canonical).saveStagedProductPhoto(staged);
  await connection.query("INSERT INTO products (id,sku,title,slug,type,status) VALUES ('protocol-product','PROTOCOL-SYNTHETIC','Synthetic','protocol-synthetic','UniqueItem','Draft')");
  await connection.query("INSERT INTO ai_product_intakes (id,created_by_admin_user_id) VALUES ('protocol-intake','synthetic-admin')");
  const client=await connection.connect();await client.query('BEGIN');
  const outboxOnly=boundary==='pg-protocol-outbox-only';
  if(!outboxOnly){
   await client.query("INSERT INTO ai_intake_photos (id,intake_id,storage_key,original_filename,created_by_admin_user_id) VALUES ('protocol-ai','protocol-intake',$1,'synthetic.png','synthetic-admin')",[privatePhoto.storageKey]);
   await client.query("INSERT INTO product_photos (id,product_id,url,thumbnail_url,filename,mime_type,size_bytes,width,height,storage_key,thumbnail_storage_key,processing_status) VALUES ('protocol-photo','protocol-product',$1,$2,$3,'image/webp',$4,$5,$6,$3,$7,'Processing')",[stored.url,stored.thumbnailUrl,stored.filename,stored.sizeBytes,stored.width,stored.height,require('node:path').basename(stored.thumbnailUrl)]);
  }
  const payload=outboxOnly?{storageKey:stored.filename,thumbnailStorageKey:require('node:path').basename(stored.thumbnailUrl)}:{photoId:'protocol-photo',productId:'protocol-product'};
  await client.query("INSERT INTO outbox_events (id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,available_at) VALUES ('protocol-event',$1,'ProductPhoto','protocol-photo','protocol-idempotency',$2::jsonb,$3,now())",[outboxOnly?'product_photo.delete_requested':'product_photo.promote_requested',JSON.stringify(payload),outboxOnly?'DeadLetter':'Pending']);
  details={scope:'native-postgresql-transaction-fixture-not-photo-service'};
  if(boundary==='pg-protocol-uncommitted')checkpoint('protocol-rows-before-commit');
  await client.query('COMMIT');checkpoint(outboxOnly?'protocol-outbox-only-after-commit':'protocol-rows-after-commit');
 }
 if(boundary==='retry-finalize'){
  const [intake]=await db.select().from(schema.aiProductIntakes);
  let result;try{const finalized=await service('aiIntakePhotoFinalization').finalizeAiIntakePhotos(db,intake.id,{},'synthetic-admin');result={ok:true,created:finalized.created};}catch(error){result={ok:false,name:error.name};}
  if(driver==='sqlite')connection.close();else await connection.end();fs.writeSync(1,JSON.stringify(result)+'\n');return;
 }
 details={journalMode:driver==='sqlite'?connection.pragma('journal_mode',{simple:true}):null};
 const processor=api('sharp');const enums=api('@noctella/shared');const time=driver==='sqlite'?new Date().toISOString():new Date();
 await db.insert(schema.products).values({id:'synthetic-product',sku:'CRASH-SYNTHETIC',title:'Synthetic',slug:'synthetic',type:enums.ProductType.UniqueItem,status:enums.ProductStatus.Draft,priceEur:driver==='sqlite'?10:'10',createdAt:time,updatedAt:time});
 stage='create-intake';const intake=await service('aiProductIntakes').createIntake(db,'synthetic-admin');
 const isProduct=boundary.startsWith('product-');const isFinalize=boundary.startsWith('finalize-');
 const ingress=isProduct?'product-ingress':'ai-ingress';const workDir=path.join(root,ingress,'request-synthetic');fs.mkdirSync(workDir,{recursive:true,mode:0o700});
 const bytes=await processor({create:{width:32,height:24,channels:3,background:'#a08060'}}).png().toBuffer();fs.writeFileSync(path.join(workDir,'input'),bytes,{flag:'wx',mode:0o600});
 const staged={path:path.join(workDir,'input'),workDir,size:bytes.length,mimetype:'image/png',signal:new AbortController().signal};
 if(boundary==='ai-reserved-output'||boundary==='ai-encoded-output'){
  const original=processor.prototype.toFile;
  processor.prototype.toFile=async function(...args){if(boundary==='ai-reserved-output')checkpoint('reserved-output-before-encode');const result=await original.apply(this,args);checkpoint('encoded-output-before-db');return result;};
 }
 if(boundary==='product-one-link'){
  const storage=new (service('stagedProductPhotoStorage').LocalStagedProductPhotoStorage)(path.join(root,'canonical'),async(src,dest)=>{await fs.promises.link(src,dest);checkpoint('first-canonical-link-before-second');});
  await service('products').uploadStagedProductPhoto(db,'synthetic-product',staged,'Synthetic',storage);throw Error('Missed checkpoint');
 }
 if(boundary==='instagram-temp'){
  const canonical=path.join(root,'canonical');fs.mkdirSync(canonical,{recursive:true});const image=await processor(bytes).webp().toBuffer();fs.writeFileSync(path.join(canonical,'instagram-source.webp'),image);
  await db.insert(schema.productPhotos).values({id:'instagram-source',productId:'synthetic-product',url:'/images/product-photos/instagram-source.webp',thumbnailUrl:'/images/product-photos/instagram-source.webp',filename:'instagram-source.webp',mimeType:'image/webp',sizeBytes:image.length,width:32,height:24,storageKey:'instagram-source.webp',thumbnailStorageKey:'instagram-source.webp',processingStatus:'Ready',createdAt:time,updatedAt:time});
  const promises=require('node:fs/promises');const originalLink=promises.link;promises.link=async(src,dest)=>{if(path.basename(src).startsWith('.instagram-'))checkpoint('instagram-temp-written-before-link');return originalLink(src,dest);};
  await require('../../apps/api/src/integrations/instagram/mediaPreparation.ts').prepareInstagramImageAsset({url:'/images/product-photos/instagram-source.webp'},'https://api.synthetic.test',{INSTAGRAM_MEDIA_ALLOWED_HOSTS:'api.synthetic.test'},canonical);throw Error('Missed Instagram checkpoint');
 }
 if(isFinalize){await service('aiIntakePhotos').uploadStagedIntakePhoto(db,intake.id,staged,'synthetic.png','synthetic-admin');await db.update(schema.aiProductIntakes).set({status:enums.AiProductIntakeStatus.Applied,resultProductId:'synthetic-product'}).where(api('drizzle-orm').eq(schema.aiProductIntakes.id,intake.id));}
 if(boundary==='finalize-first-output'||boundary==='finalize-zero-output'){
  const promises=require('node:fs/promises');const originalWrite=promises.writeFile;
  promises.writeFile=async(dest,...args)=>{if(path.dirname(String(dest))===path.join(root,'canonical')){if(boundary==='finalize-zero-output')fs.writeFileSync(dest,Buffer.alloc(0),{flag:'wx'});else await originalWrite(dest,...args);checkpoint(boundary==='finalize-zero-output'?'injected-open-before-first-write':'first-deterministic-output-before-thumbnail');}return originalWrite(dest,...args);};
 }
 if(boundary==='ai-rollback-error')db.transaction=()=>{throw Error('synthetic-before-transaction');};
 const originalTransaction=db.transaction.bind(db);
 if(/-(uncommitted|committed|lost-ack)$/.test(boundary)) {
  const finish=()=>{if(boundary.endsWith('-committed'))checkpoint('commit-complete-before-response');if(boundary.endsWith('-lost-ack'))throw Error('synthetic-lost-commit-ack');};
  if(driver==='sqlite')db.transaction=(callback,...options)=>{const result=originalTransaction(tx=>{const value=callback(tx);if(boundary.endsWith('-uncommitted'))checkpoint('rows-and-outbox-before-commit');return value;},...options);finish();return result;};
  else db.transaction=async(callback,...options)=>{const result=await originalTransaction(async tx=>{const value=await callback(tx);if(boundary.endsWith('-uncommitted'))checkpoint('rows-and-outbox-before-commit');return value;},...options);finish();return result;};
 }
 try {
  if(isFinalize)await service('aiIntakePhotoFinalization').finalizeAiIntakePhotos(db,intake.id,{},'synthetic-admin');
  else if(isProduct)await service('products').uploadStagedProductPhoto(db,'synthetic-product',staged,'Synthetic');
  else await service('aiIntakePhotos').uploadStagedIntakePhoto(db,intake.id,staged,'synthetic.png','synthetic-admin');
 } catch(error){if(boundary.endsWith('-lost-ack')||boundary==='ai-rollback-error'){const gate=service('photoUploadAdmission');let rejected=false;try{await gate.runImageOperation(async()=>true);}catch{rejected=true;}const enabled=process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED;process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED='false';const legacyBypass=await gate.runImageOperation(async()=>true);process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED=enabled;details={...details,code:error.code,admission:gate.imageProcessingAdmission.snapshot(),enabledWorkRejected:rejected,legacyBypass};checkpoint('persistence-error-after-service-handler');}throw error;}
 throw Error('Missed crash boundary');
})().catch(error=>{fs.writeSync(2,JSON.stringify({name:error.name,code:error.code,stage,message:driver==='sqlite'||(error instanceof TypeError&&String(error.message).includes('toISOString'))?String(error.message):'Synthetic PostgreSQL probe failed'})+'\n');process.exit(2);});
