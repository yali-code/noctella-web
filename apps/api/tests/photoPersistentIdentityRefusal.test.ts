import { expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const call=vi.hoisted(()=>({run:vi.fn()}));
vi.mock("node:child_process",()=>({spawnSync:call.run}));
vi.mock("../src/services/photoPreparationConfinement",()=>({photoPreparationConfinementConfig:()=>({mode:"confined",launcher:"/reviewed/helper"})}));
import { persistentPhotoDevice } from "../src/services/photoPersistentIdentity";
afterEach(()=>vi.restoreAllMocks());
for(const response of [{status:125,stdout:""},{status:0,stdout:"label"},{status:0,stdout:"0".repeat(32)},{status:0,stdout:"f".repeat(31)},{status:0,stdout:"f".repeat(32)+" extra"},{status:null,stdout:"f".repeat(32),error:Error("timeout")}] ) it("refuses unavailable or malformed descriptor UUID evidence "+JSON.stringify(response),()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"noctella-uuid-refusal-")),file=path.join(root,"input");fs.writeFileSync(file,"synthetic");const fd=fs.openSync(file,"r");call.run.mockReturnValue(response);
  try{expect(()=>persistentPhotoDevice(fd,fs.fstatSync(fd,{bigint:true}))).toThrow("PHOTO_PERSISTENT_IDENTITY_UNAVAILABLE");}finally{fs.closeSync(fd);}
});
it("refuses descriptor identity substitution during native evidence acquisition",()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"noctella-uuid-swap-")),file=path.join(root,"input");fs.writeFileSync(file,"synthetic");const fd=fs.openSync(file,"r");const st=fs.fstatSync(fd,{bigint:true});call.run.mockImplementation(()=>{vi.spyOn(fs,"fstatSync").mockReturnValue(Object.assign(Object.create(Object.getPrototypeOf(st)),st,{ino:st.ino+1n}));return{status:0,stdout:"f".repeat(32)};});try{expect(()=>persistentPhotoDevice(fd,st)).toThrow("PHOTO_PERSISTENT_IDENTITY_CHANGED");}finally{fs.closeSync(fd);}});
