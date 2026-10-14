// Fresh-process restart inventory of disposable test state only.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {createHash}=require('node:crypto');const {createRequire}=require('node:module');
const api=createRequire(path.resolve(__dirname,'../../apps/api/package.json'));
const [root,driver,schemaName]=process.argv.slice(2);
if(!root||!path.resolve(root).startsWith(path.join(os.tmpdir(),'noctella-photo-crash-'))||fs.realpathSync(root)!==path.resolve(root))throw Error('Disposable restart inventory only');
(async()=>{
 let close,query;
 if(driver==='sqlite'){
  const Database=api('better-sqlite3');const db=new Database(path.join(root,'test.sqlite'),{fileMustExist:true});
  // Opening the retained disposable DB allows SQLite's own hot-journal recovery.
  db.pragma('query_only = ON');db.exec('BEGIN');query=async sql=>db.prepare(sql).all();close=async()=>{db.exec('COMMIT');db.close();};
 }else if(driver==='postgres'){
  require('../../apps/api/tests/postgresTestDb.ts').assertDisposablePostgresUrl(process.env.POSTGRES_TEST_DATABASE_URL);const u=new URL(process.env.POSTGRES_TEST_DATABASE_URL);
  if(!['localhost','127.0.0.1','::1'].includes(u.hostname)||!/^sprint151_test_[a-f0-9]+$/.test(schemaName))throw Error('Local disposable PostgreSQL only');
  const pg=api('pg');const client=new pg.Client({connectionString:process.env.POSTGRES_TEST_DATABASE_URL,options:'-c search_path='+schemaName});await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');query=async sql=>(await client.query(sql)).rows;close=async()=>{await client.query('COMMIT');await client.end();};
 }else throw Error('Unsupported probe driver');
 const photos=await query('SELECT id,filename,url,thumbnail_url AS "thumbnailUrl",storage_key AS "storageKey",thumbnail_storage_key AS "thumbnailStorageKey",processing_status AS "processingStatus",created_at AS "createdAt",updated_at AS "updatedAt",processing_updated_at AS "processingUpdatedAt" FROM product_photos ORDER BY id');
 const aiPhotos=await query('SELECT id,intake_id AS "intakeId",storage_key AS "storageKey",created_at AS "createdAt",updated_at AS "updatedAt" FROM ai_intake_photos ORDER BY id');
 const outbox=await query('SELECT id,event_type AS "eventType",aggregate_id AS "aggregateId",status,payload,available_at AS "availableAt",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt",dead_lettered_at AS "deadLetteredAt",locked_at AS "lockedAt" FROM outbox_events ORDER BY id');
 const intakes=await query('SELECT id,status,result_product_id AS "resultProductId",created_at AS "createdAt",updated_at AS "updatedAt",applied_at AS "appliedAt",cancelled_at AS "cancelledAt",finalized_at AS "finalizedAt" FROM ai_product_intakes ORDER BY id');await close();
 const files=[];
 function scan(base,relative,kind){if(files.length>=200||relative.split('/').length>4)throw Error('Inventory cap');const full=path.join(base,relative);const info=fs.lstatSync(full);if(info.isSymbolicLink()){files.push({root:kind,key:relative,kind:'symlink',size:info.size});return;}if(info.isDirectory()){for(const entry of fs.readdirSync(full).sort())scan(base,path.posix.join(relative,entry),kind);}else if(info.isFile()){if(info.size>16*1024*1024)throw Error('Synthetic file cap');files.push({root:kind,key:relative,kind:'file',size:info.size,dev:info.dev,ino:info.ino,nlink:info.nlink,sha256:createHash('sha256').update(fs.readFileSync(full)).digest('hex')});}else files.push({root:kind,key:relative,kind:'special',size:info.size});}
 for(const kind of ['canonical','intake','product-ingress','ai-ingress','legacy-temp']){const base=path.join(root,kind);if(fs.existsSync(base))scan(base,'',kind);}
 fs.writeSync(1,JSON.stringify({dbAvailable:true,quiesced:true,rootAliases:{"legacy-temp":"canonical"},photos,aiPhotos,outbox,intakes,files})+'\n');
})().catch(()=>{fs.writeSync(2,'Disposable restart inventory unavailable\n');process.exit(2);});
