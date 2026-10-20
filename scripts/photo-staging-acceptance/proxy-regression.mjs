// Reproduce the exact pinned driver's first-response defect using synthetic loopback traffic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {pathToFileURL} from "node:url";
import {startAckDroppingProxy,selectIntendedResponse} from "./staging-driver.mjs";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"f2-proxy-before-"));
const baseline=path.join(dir,"baseline.mjs");fs.copyFileSync(new URL("../../docs/engineering/f2-guarded-tooling-evidence/baseline-staging-driver.mjs.txt",import.meta.url),baseline);
const old=await import(pathToFileURL(baseline));
const id="12345678-1234-4123-8123-123456789abc", route=`/api/products/${id}/photos`, key="f2-synthetic-before-after";
const server=http.createServer((req,res)=>{req.resume();req.on("end",()=>{res.statusCode=req.url===route?201:401;res.end(JSON.stringify(req.url===route?{id}:{error:"unauthorized"}));});});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const url=new URL(`http://127.0.0.1:${server.address().port}`);
const output=[];
try{for(const [name,start] of [["before",old.startAckDroppingProxy],["after",startAckDroppingProxy]]){const proxy=await start(url,{method:"POST",path:route,key});try{for(const request of [{path:"/unrelated",method:"GET"},{path:route,method:"POST"}]){try{await fetch(new URL(request.path,proxy.url),{method:request.method,headers:{"idempotency-key":key}});throw Error("ack delivered");}catch(e){if(e.message==="ack delivered")throw e;}}const selected=name==="before"?proxy.captured[0]:selectIntendedResponse(proxy);output.push({revision:name,synthetic:true,statuses:proxy.captured.map(r=>r.status),selectedStatus:selected.status,expectedStatus:201,pass:selected.status===201});}finally{await proxy.close();}}if(output[0].pass || !output[1].pass)throw Error("regression result incorrect");console.log(JSON.stringify(output,null,2));}finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true});}
