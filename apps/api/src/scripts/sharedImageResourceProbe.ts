// Offline synthetic combined-load probe; never a publishing or production entry point.
import fs from "node:fs/promises";
import { createReadStream, appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

export async function runCombinedScenario(config: any) {
  if (process.platform !== "linux" || process.env.PRODUCT_PHOTO_DIR !== "/work/photos" || process.env.TMPDIR !== "/work/tmp") throw Error("Disposable Linux environment required");
  Object.assign(process.env, { NODE_ENV:"test", DATABASE_DRIVER:"sqlite", DATABASE_URL:"/work/api.sqlite", PRODUCT_PHOTO_DISK_STAGING_ENABLED:"true", AI_INTAKE_PHOTO_DIR:"/work/intake", MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY:Buffer.alloc(32,4).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET:"synthetic-state", ADMIN_APP_ORIGIN:"http://localhost:3001", STOREFRONT_APP_ORIGIN:"http://localhost:3000", SCHEDULER_AUTH_TOKEN:"synthetic-scheduler" });
  const { AdminRole, ProductType, ProductStatus, AiProductIntakeStatus }=await import("@noctella/shared");
  const app=(await import("../app")).default;
  const {db,dbRuntime}=await import("../db/client");
  const {createAdminUser,login}=await import("../services/adminAuth");
  const {SESSION_COOKIE_NAME}=await import("../auth/cookies");
  const {createCategory}=await import("../services/categories");
  const {createProduct}=await import("../services/products");
  const {productPhotos,outboxEvents,aiIntakePhotos,aiProductIntakes}=await import("../db/schema");
  const {eq}=await import("drizzle-orm");
  const {imageProcessingAdmission}=await import("../services/photoUploadAdmission");
  const instagram=await import("../integrations/instagram/mediaPreparation");
  const sharp=(await import("sharp")).default;
  const trace = (phase:string, details:Record<string,unknown>={}) => {
    const number=(name:string)=>Number(readFileSync("/sys/fs/cgroup/"+name,"utf8"));
    appendFileSync("/evidence/phases.ndjson",JSON.stringify({time:Date.now(),phase,...details,memory:process.memoryUsage(),cgroupCurrent:number("memory.current"),cgroupPeak:number("memory.peak"),events:readFileSync("/sys/fs/cgroup/memory.events","utf8"),stat:readFileSync("/sys/fs/cgroup/memory.stat","utf8"),cache:sharp.cache()})+"\n");
  };
  const originalRead=fs.readFile;
  fs.readFile=(async(...args:any[])=>{trace("read.start",{file:String(args[0])});const result=await (originalRead as any)(...args);trace("read.end",{file:String(args[0]),bytes:result.length});return result;}) as typeof fs.readFile;
  let nativeActive=0,nativePeak=0,nativeCalls=0;
  const originals=new Map<string,any>();
  for(const method of ["metadata","toFile","toBuffer"]){
    const prototype=sharp.prototype as any, original=prototype[method];originals.set(method,original);
    prototype[method]=function(...args:any[]){
      trace("native.start",{method,input:typeof this.options?.input?.file === "string" ? this.options.input.file : "buffer",output:args[0],width:this.options?.width,height:this.options?.height});
      nativeActive++;nativeCalls++;nativePeak=Math.max(nativePeak,nativeActive);
      try { return Promise.resolve(original.apply(this,args)).finally(()=>{nativeActive--;trace("native.end",{method});}); }
      catch(error){nativeActive--;throw error;}
    };
  }
  const actor=await createAdminUser(db,{email:"combined@synthetic.test",role:AdminRole.Owner,password:"synthetic-password-123"});
  const session=await login(db,{email:"combined@synthetic.test",password:"synthetic-password-123"});
  const cookie=SESSION_COOKIE_NAME+"="+session.rawToken;
  const category=await createCategory(db,{name:"Synthetic",displayOrder:0,isActive:true});
  async function product(sku:string) {
    return createProduct(db,{sku,title:"Synthetic "+sku,type:ProductType.UniqueItem,status:ProductStatus.Draft,categoryId:category.id,priceEur:10,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false});
  }
  const sourceProduct=await product("SOURCE"),targetProduct=await product("TARGET"),aiProduct=await product("AI");
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const port=(server.address() as import("node:net").AddressInfo).port;
  const baseline={memory:process.memoryUsage(),cgroupCurrent:Number(await fs.readFile("/sys/fs/cgroup/memory.current","utf8"))};
  let peak=process.memoryUsage();
  const sample=()=>{const current=process.memoryUsage();for(const key of Object.keys(current) as (keyof typeof current)[])peak[key]=Math.max(peak[key],current[key]);};
  const sampler=setInterval(sample,10),started=Date.now(),operations:any[]=[];
  await fs.writeFile("/evidence/baseline.json",JSON.stringify(baseline,null,2));
  function response(reqPath:string,body:string):Promise<{status:number;body:any}> {
    return new Promise((resolve,reject)=>{
      const req=http.request({host:"127.0.0.1",port,path:reqPath,method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{
        let text="";res.on("data",chunk=>{text+=chunk.toString();if(text.length>32768)res.destroy(Error("Response budget exceeded"));});
        res.on("error",reject);res.on("end",()=>{try{resolve({status:res.statusCode!,body:JSON.parse(text)});}catch(error){reject(error);}});
      });req.on("error",reject);req.end(body);
    });
  }
  const fixture=config.fixtures.find((f:any)=>f.name===config.scenario.fixtures[0]);
  if(!fixture)throw Error("Missing synthetic fixture");
  const input=path.join("/fixtures",path.basename(fixture.file)),inputSize=(await fs.stat(input)).size;
  function multipart(reqPath:string):Promise<{status:number;body:any}> {
    const boundary="synthetic-combined";
    const head=Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="photo"; filename="synthetic.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
    const tail=Buffer.from('\r\n--'+boundary+'--\r\n');
    return new Promise((resolve,reject)=>{
      let received=false;
      const req=http.request({host:"127.0.0.1",port,path:reqPath,method:"POST",headers:{Cookie:cookie,"Content-Type":"multipart/form-data; boundary="+boundary,"Content-Length":head.length+inputSize+tail.length}},res=>{
        received=true;let text="";res.on("data",chunk=>{text+=chunk.toString();if(text.length>32768)res.destroy(Error("Response budget exceeded"));});
        res.on("error",reject);res.on("end",()=>{try{resolve({status:res.statusCode!,body:JSON.parse(text)});}catch(error){reject(error);}});
      });
      req.on("error",error=>{if(!received)reject(error);});req.write(head);
      const stream=createReadStream(input);stream.on("error",reject);
      req.once("response",()=>{stream.unpipe(req);stream.destroy();if(!req.writableEnded)req.end();});
      stream.pipe(req,{end:false});stream.once("end",()=>req.end(tail));
    });
  }
  async function record<T extends {status:number;body:any}>(kind:string,work:()=>Promise<T>,expected:number):Promise<T> {
    const start=Date.now();trace("workflow.start",{kind});const result=await work();trace("workflow.end",{kind,status:result.status});
    operations.push({index:operations.length,kind,status:result.status,ok:result.status===expected,asExpected:result.status===expected,durationMs:Date.now()-start});
    await fs.writeFile("/evidence/progress.json",JSON.stringify({operations,nativePeak,nativeCalls},null,2));
    if(result.status!==expected)throw Error("Unexpected synthetic workflow status: "+kind+" "+result.status);
    return result;
  }
  try {
    const source=await record("product.setup",()=>multipart("/api/products/"+sourceProduct.id+"/photos"),201);
    const a=await response("/api/ai-product-intakes","{}"),b=await response("/api/ai-product-intakes","{}");
    if(a.status!==201||b.status!==201)throw Error("Intake setup failed");
    const staged=await record("ai.upload.setup",()=>multipart("/api/ai-product-intakes/"+a.body.id+"/photos"),201);
    await db.update(aiProductIntakes).set({status:AiProductIntakeStatus.Applied,resultProductId:aiProduct.id}).where(eq(aiProductIntakes.id,a.body.id));
    const {createHash}=await import("node:crypto");
    async function digest(file: string) { const hash=createHash("sha256"); for await(const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex"); }
    const sourceHash=await digest("/work/intake/"+staged.body.storageKey);
    const warmBeforeCombined={memory:process.memoryUsage(),cgroupCurrent:Number(await fs.readFile("/sys/fs/cgroup/memory.current","utf8"))};
    let prepared!: Awaited<ReturnType<typeof instagram.prepareInstagramImageAsset>>;
    await Promise.all([
      record("product.upload.wave1",()=>multipart("/api/products/"+targetProduct.id+"/photos"),201),
      record("ai.upload.wave1",()=>multipart("/api/ai-product-intakes/"+b.body.id+"/photos"),201),
      record("instagram.prepare",async()=>{prepared=await instagram.prepareInstagramImageAsset({url:source.body.url},"https://api.synthetic.test",{INSTAGRAM_MEDIA_ALLOWED_HOSTS:"api.synthetic.test"});return{status:200,body:prepared};},200),
    ]);
    const results=await Promise.all([
      record("product.upload.wave2",()=>multipart("/api/products/"+targetProduct.id+"/photos"),201),
      record("ai.finalize",()=>response("/api/ai-product-intakes/"+a.body.id+"/finalize-photos","{}"),201),
      record("instagram.inspect",async()=>{const valid=await instagram.inspectPreparedInstagramImage({url:source.body.url},prepared);return{status:valid?200:500,body:{valid}};},200),
    ]);
    if(results[1].body.photos[0].id!==staged.body.id)throw Error("Deterministic photo identity changed");
    if(await digest("/work/intake/"+staged.body.storageKey)!==sourceHash)throw Error("AI source changed");
    const rows=await db.select().from(productPhotos),events=await db.select().from(outboxEvents),aiRows=await db.select().from(aiIntakePhotos);
    const privateFiles=await fs.readdir("/work/intake"),photoFiles=await fs.readdir("/work/photos");
    const tmpDirFiles=[...await fs.readdir("/work/tmp"),...await fs.readdir("/work/.product-photo-upload-staging"),...await fs.readdir("/work/.ai-intake-upload-ingress")];
    if(rows.length!==4||events.length!==4||aiRows.length!==2||privateFiles.length!==2||nativePeak!==1||nativeActive!==0||nativeCalls<20||imageProcessingAdmission.snapshot().held!==0)throw Error("Combined integrity/admission mismatch");
    sample();
    return {scenario:config.scenario,operations,baseline,warmBeforeCombined,peak,peakMaxRss:process.resourceUsage().maxRSS*1024,totalDurationMs:Date.now()-started,nativePeak,nativeCalls,admission:imageProcessingAdmission.snapshot(),retainedAiSourceFiles:privateFiles.length,leftovers:{photoDirFiles:photoFiles.length,expectedPhotoDirFiles:9,tmpDirFiles},scope:"synthetic authenticated product/AI HTTP and local-only Instagram; no provider calls; not full production acceptance"};
  } finally {
    clearInterval(sampler);
    fs.readFile=originalRead;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await dbRuntime.shutdown();
    for(const[method,original]of originals)(sharp.prototype as any)[method]=original;
  }
}
