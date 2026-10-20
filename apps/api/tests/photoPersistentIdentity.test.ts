import { expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistentPhotoDevice, matchesPhotoDevice, persistentStorageId } from "../src/services/photoPersistentIdentity";
import { ownedPhotoArtifactProof } from "../src/services/ownedPhotoArtifactProof";
import { publishVerifiedCopy, type CopyRecord } from "../src/services/photoCopyPublisher";
afterEach(() => vi.unstubAllEnvs());
it("rejects malformed versions and preserves strict numeric legacy semantics", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"noctella-pfs-codec-")), file=path.join(root,"input");fs.writeFileSync(file,"synthetic");const fd=fs.openSync(file,"r");
  try {const st=fs.fstatSync(fd,{bigint:true});expect(matchesPhotoDevice(fd,st,String(st.dev))).toBe(true);expect(matchesPhotoDevice(fd,st,String(st.dev+1n))).toBe(false);for(const value of ["", "pfs1:bad:1", "pfs2:123", "pfs1:"+"f".repeat(32)+":0"]){expect(persistentStorageId(value)).toBe(null);expect(matchesPhotoDevice(fd,st,value)).toBe(false);}}finally{fs.closeSync(fd);}
});
const linuxRequired=process.env.F2_CAPABILITY_REQUIRE_LINUX === "1";
it.runIf(linuxRequired)("required Linux descriptor UUID proof and runtime publisher use the packaged launcher", async () => {
  expect(process.platform).toBe("linux");expect(process.getuid!()).not.toBe(0);
  vi.stubEnv("PHOTO_PREPARATION_CONFINEMENT","required");vi.stubEnv("PHOTO_PREPARATION_LAUNCHER",process.env.F2_CAPABILITY_LAUNCHER!);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"noctella-native-pfs-")),file=path.join(root,"input"),canonicalDir=path.join(root,"canonical"),stagingDir=path.join(root,"staging");fs.writeFileSync(file,"native-synthetic");fs.mkdirSync(canonicalDir);fs.mkdirSync(stagingDir);
  const seal=await ownedPhotoArtifactProof(file,true);expect(seal.dev).toMatch(/^pfs1:[0-9a-f]{32}:[1-9][0-9]*$/);
  let copy:CopyRecord|null=null;const target={source:file,seal:{...seal,size:seal.bytes},canonicalDir,canonicalName:"photo.webp",stagingDir,retainStagingLink:true};const ledger={read:async()=>copy,record:async(value:CopyRecord)=>{copy=value;}};
  expect((await publishVerifiedCopy(target,ledger)).kind).toBe("PUBLISHED");expect((await publishVerifiedCopy(target,ledger)).kind).toBe("ADOPTED");
  const padding=Array.from({length:8},()=>fs.openSync(file,"r"));const fd=fs.openSync(file,"r");expect(fd).toBeGreaterThan(3);try{const proof=persistentPhotoDevice(fd,fs.fstatSync(fd,{bigint:true}));expect(proof).toBe(seal.dev);}finally{fs.closeSync(fd);padding.forEach(value=>fs.closeSync(value));}
  if(process.env.PHOTO_REMOUNT_EVIDENCE_DIR){fs.mkdirSync(process.env.PHOTO_REMOUNT_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(root,"native-proof.json"),JSON.stringify({simulated:false,seal,copy},null,2));fs.cpSync(root,path.join(process.env.PHOTO_REMOUNT_EVIDENCE_DIR,path.basename(root)),{recursive:true});}
});
