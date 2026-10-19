/** SIMULATED kernel UUID/device observations; real owners/DB/recipes. Not Render or actual mount acceptance. */
import fs from "node:fs";
import { vi } from "vitest";
import * as identity from "../../src/services/photoPersistentIdentity";
export function simulatedPersistentRemount() {
  let shifted=false;
  const uuid="aabbccddeeff00112233445566778899";
  const token=(st:fs.BigIntStats)=>"pfs1:"+uuid+":"+st.birthtimeNs;
  const spies=[vi.spyOn(identity,"sealedPhotoDevice").mockImplementation((_fd,st)=>token(st)),vi.spyOn(identity,"persistentPhotoDevice").mockImplementation((_fd,st)=>token(st)),vi.spyOn(identity,"matchesPhotoDevice").mockImplementation((_fd,st,expected)=>token(st)===expected),vi.spyOn(identity,"assertPublicationStorage").mockImplementation((_dir,expected)=>{if(identity.persistentStorageId(expected)!==uuid)throw Error("PHOTO_PERSISTENT_STORAGE_MISMATCH");})];
  for(const method of ["fstatSync","lstatSync","statSync"] as const){const original=fs[method].bind(fs) as any;spies.push(vi.spyOn(fs,method).mockImplementation(((fd:any,options:any)=>{const st=original(fd,options);return shifted&&options?.bigint?Object.assign(Object.create(Object.getPrototypeOf(st)),st,{dev:st.dev+99n}):st;}) as any) as any);}
  return {replaceInstance:()=>{shifted=true;},restore:()=>spies.forEach(spy=>spy.mockRestore())};
}
