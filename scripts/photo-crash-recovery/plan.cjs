// Offline reference model only. No filesystem or DB mutation capability.
const safeKey = key => typeof key === 'string' && /^[a-zA-Z0-9._-]+$/.test(key) && !key.includes('..');
function plan(snapshot) {
 const references=new Map(), anomalies=[];
 const add=(root,key,owner)=>{if(!safeKey(key)){anomalies.push('invalid-reference');return;}root=snapshot.rootAliases?.[root]||root;const id=root+'/'+key; if(!references.has(id))references.set(id,new Set());references.get(id).add(owner);};
 const fromUrl=(url,owner)=>{if(typeof url==='string'&&url.startsWith('/images/product-photos/'))add('canonical',url.slice('/images/product-photos/'.length),owner);};
 const photos=new Map(snapshot.photos.map(p=>[p.id,p]));
 for(const p of snapshot.photos){for(const k of [p.filename,p.storageKey,p.thumbnailStorageKey].filter(Boolean))add('canonical',k,'photo:'+p.id);fromUrl(p.url,'photo:'+p.id);fromUrl(p.thumbnailUrl,'photo:'+p.id);}
 for(const p of snapshot.aiPhotos){add('intake',p.storageKey,'ai:'+p.id);const intake=(snapshot.intakes||[]).find(i=>i.id===p.intakeId);if(intake&&['applied','finalized'].includes(intake.status)&&safeKey(intake.resultProductId)&&safeKey(p.id)){for(const suffix of ['.webp','-thumb.webp'])add('canonical',intake.resultProductId+'-'+p.id+suffix,'ai-finalization:'+p.id);}}
 for(const e of snapshot.outbox){
  if(!e.eventType.startsWith('product_photo.'))continue;
  let payload=e.payload;
  try{if(typeof payload==='string')payload=JSON.parse(payload);if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error();}catch{anomalies.push('invalid-photo-outbox');continue;}
  const photoId=payload.photoId||e.aggregateId;
  if(photoId&&!photos.has(photoId)&&!payload.storageKey&&!payload.thumbnailStorageKey)anomalies.push('unresolved-photo-outbox');
  for(const k of [payload.storageKey,payload.thumbnailStorageKey].filter(Boolean)) {add('canonical',k,'outbox:'+e.id);add('legacy-temp',k,'outbox:'+e.id);}
  fromUrl(payload.url,'outbox:'+e.id);fromUrl(payload.thumbnailUrl,'outbox:'+e.id);
 }
 const inventory=new Map(snapshot.files.map(f=>[f.root+'/'+f.key,f]));
 const entries=[];
 for(const [id,file] of inventory){
  const owners=[...(references.get(id)||[])].sort();
  let state=owners.length?(file.kind!=='file'||file.size===0?'referenced-anomaly':'protected-reference'):'unproven-ownership';
  if(file.kind!=='file')state='unsafe-entry';
  entries.push({root:file.root,key:file.key,size:file.size,sha256:file.sha256||null,owners,state,action:'retain'});
 }
 for(const [id,owners]of references)if(!inventory.has(id)){const split=id.indexOf('/');entries.push({root:id.slice(0,split),key:id.slice(split+1),owners:[...owners].sort(),state:'missing-reference',action:'retain'});}
 entries.sort((a,b)=>(a.root+'/'+a.key).localeCompare(b.root+'/'+b.key));
 return {version:1,mode:'offline-diagnosis-only',safeToMutate:false,automaticRetry:false,blockers:[...new Set(['durable-operation-ownership-missing','reference-coverage-incomplete',...(!snapshot.quiesced?['writers-not-fenced']:[]),...(snapshot.dbAvailable===false?['db-unavailable']:[]),...anomalies])].sort(),entries};
}
module.exports={plan};
