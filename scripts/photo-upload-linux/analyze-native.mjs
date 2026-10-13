import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Requested large allocations are not RSS/resident bytes. mmap/small allocations are excluded.
export function analyzeAllocations(input) {
 if(input.length>=2048)throw Error("Diagnostic event cap reached");
 const events=[...input].sort((a,b)=>a.seq-b.seq),live=new Map(),groups=new Map(),seen=new Set();let current=0,peak=0,unknownFrees=0,failedAllocations=0;
 for(const e of events){
  if(!Number.isSafeInteger(e.seq)||e.seq<0||!Number.isSafeInteger(e.bytes)||e.bytes<1048576||!Number.isSafeInteger(e.pid)||!Array.isArray(e.frames)||seen.has(e.seq))throw Error('Malformed or duplicate allocation evidence');
  seen.add(e.seq);if(e.seq>=2048)throw Error('Diagnostic event cap reached');
  const key=e.pid+':'+e.ptr;
  if(e.event==='free'||e.event==='realloc.free'){
   const old=live.get(key);if(!old){unknownFrees++;continue;}
   current-=old.bytes;old.group.liveBytes-=old.bytes;old.group.liveCount--;old.group.frees++;live.delete(key);continue;
  }
  if(!['malloc','calloc','realloc'].includes(e.event))throw Error('Unknown allocator event');
  if(e.ptr==='(nil)'){failedAllocations++;continue;}
  if(live.has(key))throw Error('Overlapping pointer lifetime');
  const groupKey=JSON.stringify({bytes:e.bytes,frames:e.frames});
  let group=groups.get(groupKey);
  if(!group){group={bytes:e.bytes,frames:e.frames,allocations:0,frees:0,liveBytes:0,liveCount:0,peakLiveBytes:0,peakLiveCount:0,threads:new Set()};groups.set(groupKey,group);}
  group.allocations++;group.liveBytes+=e.bytes;group.liveCount++;group.threads.add(e.tid);group.peakLiveBytes=Math.max(group.peakLiveBytes,group.liveBytes);group.peakLiveCount=Math.max(group.peakLiveCount,group.liveCount);
  live.set(key,{bytes:e.bytes,group});current+=e.bytes;peak=Math.max(peak,current);
 }
 return {events:events.length,requestedLargeAllocationPeakBytes:peak,requestedLargeAllocationLiveBytes:current,unknownFrees,failedAllocations,groups:[...groups.values()].sort((a,b)=>b.peakLiveBytes-a.peakLiveBytes).map(g=>({...g,threads:[...g.threads]})),limitations:'Only >=1MiB glibc requested allocations, not RSS; small allocations/mmap excluded; symbols may be stripped. First/last events can be missing on abrupt kill.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const text=fs.readFileSync(process.argv[2],'utf8').trim();console.log(JSON.stringify(analyzeAllocations(text.split('\n').map(JSON.parse)),null,2));
}
