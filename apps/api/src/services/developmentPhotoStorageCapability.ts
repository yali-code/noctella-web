/** Development-only storage foundation. No routes/default provider or recovery scanner. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { LocalStagedProductPhotoStorage } from "./stagedProductPhotoStorage";
import { writeDeterministicProductPhotoInPrivateRoot } from "./photoStorage";

declare const rootPermitBrand: unique symbol;
export type DevelopmentPrivatePhotoRoot = { readonly [rootPermitBrand]: true };
const rootPermits = new WeakMap<object,string>();
export interface PhotoOwnerToken { id: string; generation: number; owner: string; nonce: string }
export interface PhotoBinding { main: string; thumbnail: string; inputHash: string }
export interface PhotoSeal { id: string; operation: string; generation: number; relative: string; mainHash: string; thumbHash: string; mainSize: number; thumbSize: number; mainDev: string; mainIno: string; thumbDev: string; thumbIno: string }
type Maybe<T> = T | Promise<T>;
export interface DevelopmentPhotoAuthority {
  assertRoots(id:string,identity:string):Maybe<boolean>;
  execution: "synchronous" | "asynchronous";
  create(id: string, owner: string, nonce: string, now: number, ttl: number): Maybe<PhotoOwnerToken | null>;
  reclaim(id: string, expected: number, owner: string, nonce: string, now: number, ttl: number): Maybe<PhotoOwnerToken | null>;
  fenced<T>(token: PhotoOwnerToken, now: number, work: () => Maybe<T>): Maybe<T>;
  binding(id: string): Maybe<PhotoBinding>;
  saveSeal(seal: PhotoSeal): Maybe<void>;
  loadSeal(id: string, operation: string, generation: number): Maybe<PhotoSeal | null>;
}
const scopes = new AsyncLocalStorage<{ closed: boolean }>();
const lifetimes = new AsyncLocalStorage<{ active: boolean }>();
const chain = <T,U>(value: Maybe<T>, next: (value:T)=>Maybe<U>): Maybe<U> => value instanceof Promise ? value.then(next) : next(value);
const safe = (key: string) => /^[a-zA-Z0-9._-]{1,160}$/.test(key) && !key.includes("..") && key !== "." && !key.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key);
const fail = (code: string): never => { throw new Error(code); };
const boundary = () => { if(scopes.getStore()) fail("PHOTO_ASYNC_SQLITE_SCOPE_FORBIDDEN"); if(lifetimes.getStore()?.active===false)fail("PHOTO_MUTATION_CAPABILITY_REVOKED"); };
/** Resolve only an issued, still-live private producer permit; callers cannot choose paths. */
export function resolvePrivatePhotoRootPermit(permit:DevelopmentPrivatePhotoRoot):string {
  boundary();if(!permit||typeof permit!=="object"||!rootPermits.has(permit))fail("PHOTO_PRIVATE_ROOT_PERMIT_REQUIRED");
  return rootPermits.get(permit)!;
}
function directory(dir: string, privateMode: boolean) {
  boundary();
  fs.mkdirSync(dir, {recursive:true,mode:privateMode?0o700:0o755});
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(dir)!==path.resolve(dir)) fail("PHOTO_UNSAFE_ROOT");
  if(privateMode&&process.platform!=="win32"&&(stat.mode&0o077)!==0) fail("PHOTO_PRIVATE_PERMISSIONS");
}
export function photoFileProof(file:string) {
  const before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.size<=0n||before.size>16n*1024n*1024n) fail("PHOTO_INVALID_SEAL");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{const stat=fs.fstatSync(fd,{bigint:true});if(stat.dev!==before.dev||stat.ino!==before.ino)fail("PHOTO_INODE_CHANGED");const digest=createHash("sha256"),buffer=Buffer.alloc(64*1024);let size=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){digest.update(buffer.subarray(0,n));size+=n;if(size>16*1024*1024)fail("PHOTO_INVALID_SEAL");}if(BigInt(size)!==stat.size)fail("PHOTO_SEAL_CHANGED");return{sha256:digest.digest("hex"),size,dev:stat.dev.toString(),ino:stat.ino.toString(),nlink:Number(stat.nlink),mode:Number(stat.mode)};}finally{fs.closeSync(fd);}
}

/** All cooperating claims AND publications must use this capability's same marker root. */
export class DevelopmentPhotoStorageCapability {
  readonly #privateRoot:string; readonly #canonicalRoot:string;
  constructor(private readonly authority:DevelopmentPhotoAuthority, privateRoot:string, canonicalRoot:string) {
    if(!["test","development"].includes(process.env.NODE_ENV??"")||process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED!=="true") fail("PHOTO_DEVELOPMENT_CAPABILITY_DISABLED");
    this.#privateRoot=path.resolve(privateRoot);this.#canonicalRoot=path.resolve(canonicalRoot);
    const disposablePrefix=path.join(os.tmpdir(),"noctella-photo-fence-");
    if(!this.#privateRoot.startsWith(disposablePrefix)||!this.#canonicalRoot.startsWith(disposablePrefix)||path.dirname(this.#privateRoot)!==path.dirname(this.#canonicalRoot))fail("PHOTO_DISPOSABLE_CAPABILITY_REQUIRED");
    const overlap=(a:string,b:string)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
    if(overlap(this.#privateRoot,this.#canonicalRoot))fail("PHOTO_ROOT_OVERLAP");
    directory(this.#privateRoot,true);directory(this.#canonicalRoot,false);directory(path.join(this.#privateRoot,"locks"),true);
  }
  /** Wrap the actual SQLite transaction callback. Escaped continuations retain a forbidden context. */
  guardSqliteCallback<T>(work:()=>T):T { const scope={closed:false};return scopes.run(scope,()=>{try{return work();}finally{scope.closed=true;}}); }
  async #exclusive<T>(id:string, work:()=>Maybe<T>):Promise<T> {
    boundary();if(!safe(id))fail("PHOTO_INVALID_OPERATION");
    directory(this.#privateRoot,true);const locks=path.join(this.#privateRoot,"locks");directory(locks,true);
    const marker=path.join(locks,id+".lock");let fd:number;
    try{fd=fs.openSync(marker,"wx",0o600);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")fail("PHOTO_OPERATION_REVIEW_REQUIRED");throw error;}
    const owned=fs.fstatSync(fd,{bigint:true}),nonce=randomUUID();let initialized=false;
    try{const record=Buffer.from(JSON.stringify({id,nonce}));let offset=0;while(offset<record.length){const written=fs.writeSync(fd,record,offset,record.length-offset,null);if(written<=0)fail("PHOTO_MARKER_WRITE_FAILED_RETAINED");offset+=written;}fs.fsyncSync(fd);initialized=true;
      const identities=[this.#privateRoot,locks,this.#canonicalRoot].map(dir=>{directory(dir,dir!==this.#canonicalRoot);const stat=fs.lstatSync(dir,{bigint:true});return{dev:stat.dev.toString(),ino:stat.ino.toString()};});
      const rootId=createHash("sha256").update(this.#privateRoot+"\0"+this.#canonicalRoot).digest("hex");
      if(!await this.authority.assertRoots(rootId,JSON.stringify(identities)))fail("PHOTO_ROOT_IDENTITY_CHANGED");
      return await work();}
    finally{
      fs.closeSync(fd);
      // No stale-marker removal. Only this still-live invocation can release its exact marker.
      if(initialized){
        const current=fs.lstatSync(marker,{bigint:true});if(current.dev!==owned.dev||current.ino!==owned.ino||!current.isFile()||current.isSymbolicLink()||current.size>1024n)fail("PHOTO_MARKER_CHANGED_RETAINED");
        const check=fs.openSync(marker,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
        try{const stat=fs.fstatSync(check,{bigint:true});if(stat.dev!==owned.dev||stat.ino!==owned.ino||stat.size>1024n)fail("PHOTO_MARKER_CHANGED_RETAINED");const bytes=Buffer.alloc(1024);const count=fs.readSync(check,bytes,0,bytes.length,0);let record;try{record=JSON.parse(bytes.subarray(0,count).toString("utf8"));}catch{fail("PHOTO_MARKER_CHANGED_RETAINED");}if(record.id!==id||record.nonce!==nonce)fail("PHOTO_MARKER_CHANGED_RETAINED");}finally{fs.closeSync(check);}
        fs.unlinkSync(marker);
      }
    }
  }
  begin(id:string,owner:string,nonce:string,now:number,ttl:number){return this.#exclusive(id,()=>this.authority.create(id,owner,nonce,now,ttl));}
  reclaim(id:string,generation:number,owner:string,nonce:string,now:number,ttl:number){if(!Number.isSafeInteger(generation)||generation<1||generation>=Number.MAX_SAFE_INTEGER)fail("PHOTO_INVALID_GENERATION");return this.#exclusive(id,()=>this.authority.reclaim(id,generation,owner,nonce,now,ttl));}
  #fenced<T>(token:PhotoOwnerToken,now:number,work:()=>Maybe<T>):Promise<T>{
    const frozen={...token};if(!safe(frozen.id)||!Number.isSafeInteger(frozen.generation)||frozen.generation<1)fail("PHOTO_INVALID_OPERATION");
    return this.#exclusive(frozen.id,()=>this.authority.fenced(frozen,now,()=>{
      const lifetime={active:true};
      return lifetimes.run(lifetime,()=>{
        try{const result=work();
          if(result instanceof Promise){
            if(this.authority.execution==="synchronous"){lifetime.active=false;void result.catch(()=>undefined);fail("PHOTO_ASYNC_SQLITE_AUTHORITY_FORBIDDEN");}
            return result.finally(()=>{lifetime.active=false;});
          }
          lifetime.active=false;return result;
        }catch(error){lifetime.active=false;throw error;}
      });
    }));
  }
  async #prepare(token:PhotoOwnerToken,now:number,bytes:Buffer,produce:(raw:string,work:string,permit:DevelopmentPrivatePhotoRoot)=>Promise<{main:string;thumbnail:string}>):Promise<string>{
    token=Object.freeze({...token});
    boundary();let raw="",work="";const attempt=randomUUID();const permit=Object.freeze({}) as DevelopmentPrivatePhotoRoot;
    await this.#fenced(token,now,()=>chain(this.authority.binding(token.id),binding=>{if(binding.inputHash!==createHash("sha256").update(bytes).digest("hex"))fail("PHOTO_SOURCE_IDENTITY_MISMATCH");const op=path.join(this.#privateRoot,token.id);directory(op,true);const gen=path.join(op,"g"+token.generation);directory(gen,true);const attemptDir=path.join(gen,attempt);directory(attemptDir,true);raw=path.join(attemptDir,"raw");work=path.join(attemptDir,"work");directory(raw,true);directory(work,true);rootPermits.set(permit,raw);}));
    // Native work can finish only in this immutable generation/attempt namespace.
    let output:{main:string;thumbnail:string};
    try{output=await produce(raw,work,permit);}finally{rootPermits.delete(permit);}
    return this.#fenced(token,now,()=>{
      const sealed=path.join(path.dirname(raw),"sealed");directory(sealed,true);
      for(const [source,key]of [[output.main,"main.webp"],[output.thumbnail,"thumb.webp"]]){
        if(path.dirname(source)!==raw||fs.realpathSync(source)!==path.resolve(source))fail("PHOTO_INVALID_PRIVATE_SOURCE");
        photoFileProof(source);fs.copyFileSync(source,path.join(sealed,key),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(sealed,key),0o400);
      }
      const main=photoFileProof(path.join(sealed,"main.webp")),thumb=photoFileProof(path.join(sealed,"thumb.webp"));
      const seal:PhotoSeal={id:attempt,operation:token.id,generation:token.generation,relative:path.relative(this.#privateRoot,sealed),mainHash:main.sha256,thumbHash:thumb.sha256,mainSize:main.size,thumbSize:thumb.size,mainDev:main.dev,mainIno:main.ino,thumbDev:thumb.dev,thumbIno:thumb.ino};
      return chain(this.authority.saveSeal(seal),()=>attempt);
    });
  }
  prepareProduct(token:PhotoOwnerToken,now:number,bytes:Buffer,mimetype="image/png"){if(bytes.length>10*1024*1024)fail("PHOTO_INPUT_LIMIT");bytes=Buffer.from(bytes);return this.#prepare(token,now,bytes,async(raw,work)=>{
    const input=path.join(work,"input");fs.writeFileSync(input,bytes,{flag:"wx",mode:0o600});
    const storage=new LocalStagedProductPhotoStorage(raw);const photo=await storage.saveStagedProductPhoto({path:input,workDir:work,mimetype,size:bytes.length,signal:new AbortController().signal});
    return{main:path.join(raw,photo.filename),thumbnail:path.join(raw,path.basename(photo.thumbnailUrl))};
  });}
  prepareDeterministic(token:PhotoOwnerToken,now:number,bytes:Buffer,mimetype="image/png"){if(bytes.length>10*1024*1024)fail("PHOTO_INPUT_LIMIT");bytes=Buffer.from(bytes);return this.#prepare(token,now,bytes,async(raw,_work,permit)=>{
    await writeDeterministicProductPhotoInPrivateRoot({buffer:bytes,mimetype,size:bytes.length,mainStorageKey:"main.webp",thumbnailStorageKey:"thumb.webp"},permit);
    return{main:path.join(raw,"main.webp"),thumbnail:path.join(raw,"thumb.webp")};
  });}
  /** Canonical compensation is retain-only; no URL/path-based deletion authority. */
  compensate(token:PhotoOwnerToken,now:number){return this.#fenced(token,now,()=>({disposition:"retained" as const}));}
  publish(token:PhotoOwnerToken,now:number,id:string){
    token=Object.freeze({...token});
    boundary();if(!safe(id))fail("PHOTO_INVALID_SEAL");
    return this.#fenced(token,now,()=>chain(this.authority.binding(token.id),binding=>chain(this.authority.loadSeal(id,token.id,token.generation),seal=>{
      if(!seal||!safe(binding.main)||!safe(binding.thumbnail)||binding.main.toLowerCase()===binding.thumbnail.toLowerCase())fail("PHOTO_INVALID_SEAL");
      const base=path.resolve(this.#privateRoot,seal!.relative),prefix=path.join(this.#privateRoot,token.id,"g"+token.generation)+path.sep;
      if(!base.startsWith(prefix)||fs.realpathSync(base)!==base)fail("PHOTO_INVALID_SEAL");
      const entries=[["main.webp",binding.main,seal!.mainHash,seal!.mainSize,seal!.mainDev,seal!.mainIno],["thumb.webp",binding.thumbnail,seal!.thumbHash,seal!.thumbSize,seal!.thumbDev,seal!.thumbIno]] as const;
      const status:string[]=[];for(const [file,key,expectedHash,expectedSize,expectedDev,expectedIno]of entries){
        boundary();const source=path.join(base,file),proof=photoFileProof(source);if(proof.sha256!==expectedHash||proof.size!==expectedSize||proof.dev!==expectedDev||proof.ino!==expectedIno||(process.platform!=="win32"&&(proof.mode&0o222)!==0))fail("PHOTO_SEAL_CHANGED");
        directory(this.#canonicalRoot,false);
        const destination=path.join(this.#canonicalRoot,key);
        if(proof.nlink>1){const existing=photoFileProof(destination);if(proof.nlink!==2||existing.dev!==proof.dev||existing.ino!==proof.ino)fail("PHOTO_UNEXPECTED_SEAL_ALIAS");}
        try{fs.linkSync(source,destination);status.push("published");}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const existing=photoFileProof(destination);if(existing.sha256!==expectedHash||existing.size!==expectedSize)fail("PHOTO_PUBLICATION_CONFLICT_RETAINED");status.push("already-present");}
      }
      return{filename:binding.main,url:"/images/product-photos/"+binding.main,thumbnailUrl:"/images/product-photos/"+binding.thumbnail,status};
    })));
  }
}
