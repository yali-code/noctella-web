import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { LocalAiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { imageProcessingAdmission as gate } from "../src/services/photoUploadAdmission";
let root:string;
beforeEach(async()=>{vi.stubEnv("PRODUCT_PHOTO_DISK_STAGING_ENABLED","true");root=await mkdtemp(path.join(os.tmpdir(),"noctella-intake-staged-"));});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true,maxRetries:3});});
async function input(bytes:Buffer){const workDir=path.join(root,"request");await mkdir(workDir);const file=path.join(workDir,"input");await writeFile(file,bytes);return{path:file,workDir,mimetype:"image/jpeg",size:bytes.length,signal:new AbortController().signal};}
it.each(["jpeg","png","webp"] as const)("preserves full-resolution oriented %s output byte-for-byte with the Buffer recipe",async format=>{
 const bytes=await sharp({create:{width:1600,height:1200,channels:3,background:"#a09060"}})[format]().withMetadata({orientation:6}).toBuffer();
 const expected=await sharp(bytes,{failOn:"error"}).rotate().webp({quality:86}).toBuffer();
 const staged=await input(bytes);staged.mimetype="image/"+format;
 const storage=new LocalAiIntakePhotoStorage(path.join(root,"private"));
 const saved=await storage.saveStagedIntakePhoto(staged),actual=await readFile(path.join(root,"private",saved.storageKey));
 expect(actual).toEqual(expected);expect(await sharp(actual).metadata()).toMatchObject({width:1200,height:1600,format:"webp"});
 expect(await readFile(staged.path)).toEqual(bytes);expect(gate.snapshot()).toMatchObject({held:0,active:0});
});
it("rejects pre-abort, size mismatch, non-owned paths and symlinks without output",async()=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:"red"}}).jpeg().toBuffer(),file=await input(bytes);
 const storage=new LocalAiIntakePhotoStorage(path.join(root,"private"));
 const signal=AbortSignal.abort();await expect(storage.saveStagedIntakePhoto({...file,signal})).rejects.toMatchObject({code:"PHOTO_UPLOAD_ABORTED"});
 await expect(storage.saveStagedIntakePhoto({...file,size:file.size+1})).rejects.toThrow("Invalid staged");
 await expect(storage.saveStagedIntakePhoto({...file,workDir:root})).rejects.toThrow("Invalid staged");
 if(process.platform!=="win32"){await rm(file.path);await symlink(path.join(root,"outside"),file.path,"file");await writeFile(path.join(root,"outside"),bytes);
 await expect(storage.saveStagedIntakePhoto(file)).rejects.toThrow("Invalid staged");}
 await expect(readdir(path.join(root,"private"))).rejects.toMatchObject({code:"ENOENT"});
});
it("waits for aborted native work to settle before releasing capacity and removes its output",async()=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:"red"}}).jpeg().toBuffer(),file=await input(bytes);
 const controller=new AbortController();let release!:()=>void,started!:()=>void;
 const hold=new Promise<void>(r=>{release=r;}),begin=new Promise<void>(r=>{started=r;});
 vi.spyOn(sharp.prototype,"toFile").mockImplementationOnce((async (destination:string)=>{await writeFile(destination,"partial");started();await hold;return{};}) as any);
 const storage=new LocalAiIntakePhotoStorage(path.join(root,"private"));
 const result=gate.scope(()=>storage.saveStagedIntakePhoto({...file,signal:controller.signal}),controller.signal);
 const rejection=expect(result).rejects.toMatchObject({code:"PHOTO_UPLOAD_ABORTED"});
 await begin;controller.abort();expect(gate.snapshot().active).toBe(1);release();await rejection;
 expect(await readdir(path.join(root,"private"))).toEqual([]);expect(await readFile(file.path)).toEqual(bytes);expect(gate.snapshot()).toMatchObject({held:0,active:0});
});
it("removes only owned partial outputs after disk failure and retains input for route cleanup",async()=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:"red"}}).jpeg().toBuffer(),file=await input(bytes),privateRoot=path.join(root,"private");
 await mkdir(privateRoot);await writeFile(path.join(privateRoot,"existing.webp"),"keep");
 vi.spyOn(sharp.prototype,"toFile").mockImplementationOnce((async (destination:string)=>{await writeFile(destination,"partial");throw Object.assign(Error("disk full"),{code:"ENOSPC"});}) as any);
 await expect(new LocalAiIntakePhotoStorage(privateRoot).saveStagedIntakePhoto(file)).rejects.toMatchObject({code:"ENOSPC"});
 expect(await readdir(privateRoot)).toEqual(["existing.webp"]);expect(await readFile(file.path)).toEqual(bytes);expect(gate.snapshot()).toMatchObject({held:0,active:0});
});
it("rejects malformed staged content and keeps the new capability disabled with the flag off",async()=>{
 const file=await input(Buffer.from("invalid")),storage=new LocalAiIntakePhotoStorage(path.join(root,"private"));
 await expect(storage.saveStagedIntakePhoto(file)).rejects.toThrow();expect(await readdir(path.join(root,"private"))).toEqual([]);
 vi.stubEnv("PRODUCT_PHOTO_DISK_STAGING_ENABLED","false");await expect(storage.saveStagedIntakePhoto(file)).rejects.toMatchObject({code:"PHOTO_STORAGE_UNAVAILABLE"});
});

it("queued cancellation and timeout occur before staged input validation or native work",async()=>{
 const invalid={path:"not-read",workDir:"not-read",size:1,mimetype:"image/jpeg",signal:new AbortController().signal};
 const storage=new LocalAiIntakePhotoStorage(path.join(root,"private"));let release!:()=>void,started!:()=>void;
 const hold=new Promise<void>(r=>{release=r;}),begin=new Promise<void>(r=>{started=r;});
 const active=gate.scope(async()=>{started();await hold;});await begin;
 const encoder=vi.spyOn(sharp.prototype,"metadata");
 const controller=new AbortController(),queued=gate.scope(()=>storage.saveStagedIntakePhoto({...invalid,signal:controller.signal}),controller.signal);
 const aborted=expect(queued).rejects.toMatchObject({code:"PHOTO_UPLOAD_ABORTED"});controller.abort();await aborted;
 vi.useFakeTimers();try{
  const waiting=gate.scope(()=>storage.saveStagedIntakePhoto(invalid));const timed=expect(waiting).rejects.toMatchObject({code:"PHOTO_QUEUE_TIMEOUT"});
  await vi.advanceTimersByTimeAsync(5001);await timed;
 }finally{vi.useRealTimers();release();await active;}
 expect(encoder).not.toHaveBeenCalled();expect(gate.snapshot()).toMatchObject({held:0,active:0});
});
it("surfaces failed partial-output cleanup and still releases admission",async()=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:"red"}}).jpeg().toBuffer(),file=await input(bytes);
 vi.spyOn(sharp.prototype,"toFile").mockImplementationOnce((async(destination:string)=>{await rm(destination);await mkdir(destination);await writeFile(path.join(destination,"partial"),"partial");throw Error("encode");}) as any);
 await expect(new LocalAiIntakePhotoStorage(path.join(root,"private")).saveStagedIntakePhoto(file)).rejects.toMatchObject({code:"PHOTO_STORAGE_UNAVAILABLE"});
 expect(gate.snapshot()).toMatchObject({held:0,active:0});expect(await readdir(path.join(root,"private"))).toHaveLength(1);
});
it("shutdown rejects waiting staged work while active native work drains, with legacy Buffer API available after restart-off policy",async()=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:"red"}}).jpeg().toBuffer(),file=await input(bytes);
 let release!:()=>void,started!:()=>void;const hold=new Promise<void>(r=>{release=r;}),begin=new Promise<void>(r=>{started=r;});
 const original=sharp.prototype.toFile;
 vi.spyOn(sharp.prototype,"toFile").mockImplementationOnce((async function(this:sharp.Sharp,destination:string){started();await hold;return original.call(this,destination);}) as any);
 const storage=new LocalAiIntakePhotoStorage(path.join(root,"private")),active=storage.saveStagedIntakePhoto(file);await begin;
 const queued=storage.saveStagedIntakePhoto(file),rejected=expect(queued).rejects.toMatchObject({code:"PHOTO_CAPACITY_BUSY"});gate.close();await rejected;
 expect(gate.snapshot().active).toBe(1);release();await active;expect(gate.snapshot()).toMatchObject({held:0,active:0,closed:true});
 vi.stubEnv("PRODUCT_PHOTO_DISK_STAGING_ENABLED","false");await expect(storage.saveIntakePhoto({buffer:bytes,size:bytes.length,mimetype:"image/jpeg"})).resolves.toHaveProperty("storageKey");
});
