/** SIMULATED kernel UUID/device observations; real owners/DB/recipes. Not Render or actual mount acceptance. */
import fs from "node:fs";
import { vi } from "vitest";
import * as identity from "../../src/services/photoPersistentIdentity";
export function simulatedPersistentRemount() {
  let shifted=false;
  const uuid="aabbccddeeff00112233445566778899";
  const token=(st:fs.BigIntStats)=>"pfs1:"+uuid+":"+st.birthtimeNs;
  const spies=[vi.spyOn(identity,"sealedPhotoDevice").mockImplementation((_fd,st)=>token(st)),vi.spyOn(identity,"persistentPhotoDevice").mockImplementation((_fd,st)=>token(st)),vi.spyOn(identity,"matchesPhotoDevice").mockImplementation((_fd,st,expected)=>token(st)===expected),vi.spyOn(identity,"assertPublicationStorage").mockImplementation((_dir,expected)=>{if(identity.persistentStorageId(expected)!==uuid)throw Error("PHOTO_PERSISTENT_STORAGE_MISMATCH");})];
  for(const method of ["fstatSync","lstatSync","statSync"] as const){const original=fs[method].bind(fs) as any;spies.push(vi.spyOn(fs,method).mockImplementation(((fd:any,options:any)=>{const st=original(fd,options);return st&&shifted&&options?.bigint?Object.assign(Object.create(Object.getPrototypeOf(st)),st,{dev:st.dev+99n}):st;}) as any) as any);}
  return {replaceInstance:()=>{shifted=true;},restore:()=>spies.forEach(spy=>spy.mockRestore())};
}

export function publicationSnapshot(root:string,operationId:string,keys:string[]) {
  const path=require("node:path"),crypto=require("node:crypto");const files:any[]=[];
  function walk(file:string){if(!fs.existsSync(file))return;const st=fs.lstatSync(file,{bigint:true});if(st.isDirectory()){for(const child of fs.readdirSync(file))walk(path.join(file,child));return;}if(!st.isFile()||st.size>1024n*1024n)throw Error("unexpected synthetic evidence file");const bytes=fs.readFileSync(file);files.push({key:path.relative(root,file),dev:String(st.dev),ino:String(st.ino),birthNs:String(st.birthtimeNs),bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),syntheticBytesBase64:bytes.toString("base64")});}
  for(const dir of [".product-photo-operations",".product-photo-publication"])walk(path.join(root,dir,operationId));for(const key of keys)walk(path.join(root,"photos",key));return files;
}
export function recordRemountEvidence(name:string,data:unknown){const path=require("node:path"),os=require("node:os");const root=process.env.PHOTO_REMOUNT_EVIDENCE_DIR??fs.mkdtempSync(path.join(os.tmpdir(),"noctella-owner-remount-evidence-"));fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,name+".json"),JSON.stringify({simulated:true,data},null,2));}
