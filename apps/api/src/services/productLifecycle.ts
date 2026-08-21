import crypto from "node:crypto";
import { MarketplaceConnectionStatus, ProductStatus, PublishChannel, PublishJobStatus, type ProductLifecycleOperation, type ProductLifecycleResult, type ProductLifecycleTarget } from "@noctella/shared";
import type { MarketplaceAdapter } from "./marketplaceAdapters";
import type { DbClient } from "../db/client";
import { createProductLifecycleRepository } from "../repositories/product-lifecycle/factory";
import { productLifecycleSchema } from "../repositories/product-lifecycle/schema";
import { beginProductPause, isTerminalExternalListingStatus, type BeginProductPauseInput } from "../use-cases/product-lifecycle/useCases";
import { decryptCredential } from "./credentialEncryption";
import { ConflictError, NotFoundError } from "./errors";
import { executeControlledRelistPublish, getAdapter, getPublishJobByIdempotencyKey, retryControlledRelistPublishJob, sanitizeMarketplaceError } from "./marketplacePublishing";
import { getProductById } from "./products";
import { eq } from "drizzle-orm";

export const marketplacePauseLeaseMs = (timeoutMs = Number(process.env.MARKETPLACE_REQUEST_TIMEOUT_MS ?? 10_000)) => Math.max(60_000, 3 * timeoutMs);
export const isProcessingTargetStale = (target: ProductLifecycleTarget, nowMs = Date.now(), leaseMs = marketplacePauseLeaseMs()) => target.status === "processing" && !!target.processingStartedAt && nowMs - Date.parse(target.processingStartedAt) > leaseMs;
type AdapterResolver = (channel: PublishChannel) => MarketplaceAdapter;
const terminal = ["ended", "inactive", "sold", "closed"];
const clone = (targets: ProductLifecycleTarget[]) => targets.map((target) => ({ ...target }));

async function connectionFor(db: DbClient, target: ProductLifecycleTarget) {
  const row = await createProductLifecycleRepository(db).getOriginalConnection(target.connectionId!, target.channel);
  if (!row || row.status !== MarketplaceConnectionStatus.Connected || !row.encryptedAccessToken) throw new ConflictError("Original marketplace connection is unavailable");
  const expiry = row.tokenExpiresAt instanceof Date ? row.tokenExpiresAt.getTime() : row.tokenExpiresAt ? Date.parse(row.tokenExpiresAt) : undefined;
  if (expiry !== undefined && expiry <= Date.now()) throw new ConflictError("Original marketplace connection is expired");
  return row;
}
function finished(target: ProductLifecycleTarget, values: Partial<ProductLifecycleTarget>): ProductLifecycleTarget { const next = { ...target, ...values }; delete next.processingStartedAt; if (next.status === "succeeded") { delete next.error; delete next.retryable; } return next; }

export async function processPauseOperation(db: DbClient, operation: ProductLifecycleOperation, adapterResolver: AdapterResolver = getAdapter, now = () => new Date()): Promise<ProductLifecycleOperation> {
  const repo = createProductLifecycleRepository(db); let targets = clone(operation.targetResults).sort((a,b)=>`${a.channel}:${a.key}`.localeCompare(`${b.channel}:${b.key}`));
  for (let index=0; index<targets.length; index++) {
    const target=targets[index]; if (target.kind!=="external" || target.status==="succeeded" || (target.status==="failed" && target.retryable===false)) continue;
    const stale=isProcessingTargetStale(target,now().getTime()); if (target.status==="processing" && !stale) return (await repo.getById(operation.id))!;
    const expected=clone(targets); targets[index]={...target,status:"processing",processingStartedAt:now().toISOString()};
    if (!await repo.replaceResultsIfCurrent(operation.id,expected,targets)) return (await repo.getById(operation.id))!;
    try {
      const connection=await connectionFor(db,target), token=decryptCredential(connection.encryptedAccessToken), adapter=adapterResolver(target.channel);
      let status:string|undefined;
      if (stale) { const remote=await adapter.fetchListingStatus(token,target.externalListingId!); status=remote.externalStatus; if (!isTerminalExternalListingStatus(status)) { const ended=await adapter.endListing(token,target.externalListingId!); status=ended.externalStatus; } }
      else { try { const ended=await adapter.endListing(token,target.externalListingId!); status=ended.externalStatus; if (!isTerminalExternalListingStatus(status)) throw new Error("Marketplace did not confirm terminal status"); } catch (error) { const remote=await adapter.fetchListingStatus(token,target.externalListingId!); if (!isTerminalExternalListingStatus(remote.externalStatus)) throw error; status=remote.externalStatus; } }
      if (!status || !isTerminalExternalListingStatus(status)) throw new Error("Marketplace listing terminal state was not proven");
      await repo.updateExternalListingStatus(operation.productId,target.internalListingId!,status); targets[index]=finished(targets[index],{status:"succeeded"});
    } catch(error) { let retryable=true; try { retryable=adapterResolver(target.channel).normalizeError(error).retryable; } catch { retryable=false; } targets[index]=finished(targets[index],{status:"failed",error:sanitizeMarketplaceError(error),retryable}); }
    await repo.update(operation.id,{targetResults:targets});
  }
  const external=targets.filter((target)=>target.kind==="external"); if (external.some((target)=>target.status==="processing")) return (await repo.getById(operation.id))!;
  const succeeded=external.filter((target)=>target.status==="succeeded").length, status=succeeded===external.length?"succeeded":succeeded===0?"failed":"partially_failed", completedAt=now().toISOString(); await repo.update(operation.id,{targetResults:targets,status,completedAt,updatedAt:completedAt}); return (await repo.getById(operation.id))!;
}

export async function pauseProduct(db: DbClient,input:BeginProductPauseInput,adapterResolver:AdapterResolver=getAdapter):Promise<ProductLifecycleResult>{ const begun=await beginProductPause(db,input); let operation=begun.operation; if(operation.status!=="succeeded"){ const reset=operation.targetResults.map((target)=>target.status==="failed"&&target.retryable!==false?finished(target,{status:"pending",error:undefined,retryable:undefined}):target); if(JSON.stringify(reset)!==JSON.stringify(operation.targetResults)){await createProductLifecycleRepository(db).update(operation.id,{targetResults:reset,status:"processing",completedAt:null});operation=(await createProductLifecycleRepository(db).getById(operation.id))!;} operation=await processPauseOperation(db,operation,adapterResolver); } return {...begun,operation}; }
export async function retryPauseOperation(db:DbClient,productId:string,operationId:string,adapterResolver:AdapterResolver=getAdapter):Promise<ProductLifecycleOperation>{const repo=createProductLifecycleRepository(db),operation=await repo.getById(operationId);if(!operation||operation.productId!==productId)throw new NotFoundError("Lifecycle operation not found");if(operation.action!=="pause")throw new ConflictError("Only Pause operations can be retried");const reset=operation.targetResults.map((target)=>target.status==="failed"&&target.retryable!==false?finished(target,{status:"pending",error:undefined,retryable:undefined}):target);await repo.update(operation.id,{targetResults:reset,status:"processing",completedAt:null});return processPauseOperation(db,(await repo.getById(operation.id))!,adapterResolver);}
export async function getProductLifecycleState(db:DbClient,productId:string){const repo=createProductLifecycleRepository(db),{products}=productLifecycleSchema() as any;const [product]=await(db as any).select().from(products).where(eq(products.id,productId));if(!product)throw new NotFoundError("Product not found");return{productId,salePausedAt:product.salePausedAt instanceof Date?product.salePausedAt.toISOString():product.salePausedAt??undefined,productStatus:product.status,productUpdatedAt:product.updatedAt instanceof Date?product.updatedAt.toISOString():product.updatedAt,operation:await repo.getLatest(productId),hasActiveExternalListings:await repo.hasNonTerminalExternalListing(productId,terminal)};}

const isoValue=(value:unknown)=>value instanceof Date?value.toISOString():String(value);
const relistKey=(operationId:string,channel:PublishChannel)=>`${operationId}:${channel}`;
export async function beginProductRelist(db:DbClient,input:{productId:string;actorAdminUserId:string;idempotencyKey:string;reason?:string}){
  const repo=createProductLifecycleRepository(db),replay=await repo.getByIdempotencyKey(input.idempotencyKey);
  if(replay){if(replay.productId!==input.productId||replay.action!=="relist")throw new ConflictError("Lifecycle idempotency key is already in use");return replay;}
  const product=await getProductById(db,input.productId);if(!product.salePausedAt)throw new ConflictError("Product is not paused");
  const pause=await repo.getLatestByAction(input.productId,"pause");if(!pause||pause.status!=="succeeded"||pause.targetResults.some(t=>t.status!=="succeeded"))throw new ConflictError("Pause targets must be fully resolved before Relist");
  const targets:ProductLifecycleTarget[]=[];
  if(pause.targetSnapshot.some(t=>t.kind==="local"&&t.channel===PublishChannel.NoctellaWeb))targets.push({key:"relist:noctella_web",kind:"local",channel:PublishChannel.NoctellaWeb,status:"pending"});
  for(const channel of [PublishChannel.Ebay,PublishChannel.Etsy]){const originals=pause.targetSnapshot.filter(t=>t.kind==="external"&&t.channel===channel),connections=[...new Set(originals.map(t=>t.connectionId).filter(Boolean))];if(!originals.length)continue;if(connections.length!==1)throw new ConflictError(`${channel} Relist requires manual connection selection`);targets.push({key:`relist:${channel}`,kind:"external",channel,connectionId:connections[0],status:"pending"});}
  if(!targets.length)throw new ConflictError("Pause operation has no channels to restore");const now=new Date().toISOString(),operation:ProductLifecycleOperation={id:`lifecycle_${crypto.randomUUID()}`,productId:input.productId,action:"relist",status:"processing",reason:input.reason,previousProductStatus:product.status as ProductStatus,targetSnapshot:clone(targets),targetResults:clone(targets),actorAdminUserId:input.actorAdminUserId,idempotencyKey:input.idempotencyKey,createdAt:now,updatedAt:now};await repo.create({...operation,completedAt:null});return operation;
}
export async function processRelistOperation(db:DbClient,operation:ProductLifecycleOperation,adapterResolver:AdapterResolver=getAdapter,now=()=>new Date()):Promise<ProductLifecycleResult>{
 const repo=createProductLifecycleRepository(db),product=await getProductById(db,operation.productId),before=product.updatedAt;let targets=clone(operation.targetResults);
 for(let i=0;i<targets.length;i++){let target=targets[i];if(target.status==="succeeded")continue;const stale=isProcessingTargetStale(target,now().getTime());if(target.status==="processing"&&!stale)return{operation:(await repo.getById(operation.id))!,productUpdatedAtBefore:before,productUpdatedAtAfter:before};const expected=clone(targets);targets[i]={...target,status:"processing",processingStartedAt:now().toISOString()};if(!await repo.replaceResultsIfCurrent(operation.id,expected,targets))return{operation:(await repo.getById(operation.id))!,productUpdatedAtBefore:before,productUpdatedAtAfter:before};const key=relistKey(operation.id,target.channel),adapter=target.kind==="external"?adapterResolver(target.channel):undefined;
  try{let result;if(stale){const existing=await getPublishJobByIdempotencyKey(db,key);if(existing?.status===PublishJobStatus.Succeeded)result={job:existing};else if(existing?.status===PublishJobStatus.RetryPending&&target.connectionId)result=await retryControlledRelistPublishJob(db,existing.id,target.connectionId,adapter);else if(existing?.status===PublishJobStatus.Processing)throw new ConflictError("Publish outcome requires manual reconciliation");else result=await executeControlledRelistPublish(db,operation.productId,target.channel,key,target.connectionId,adapter);}else{result=await executeControlledRelistPublish(db,operation.productId,target.channel,key,target.connectionId,adapter);if(result.job.status===PublishJobStatus.RetryPending&&target.connectionId)result=await retryControlledRelistPublishJob(db,result.job.id,target.connectionId,adapter);}if(result.job.status!==PublishJobStatus.Succeeded)throw new ConflictError(result.job.lastError??"Relist publish did not succeed");targets[i]=finished(targets[i],{status:"succeeded",replacementExternalListingId:result.job.externalListingId});}catch(error){targets[i]=finished(targets[i],{status:"failed",error:sanitizeMarketplaceError(error),retryable:!(error instanceof ConflictError&&error.message.includes("manual reconciliation"))});}await repo.update(operation.id,{targetResults:targets});
 }
 const succeeded=targets.filter(t=>t.status==="succeeded").length;if(succeeded!==targets.length){const status=succeeded?"partially_failed":"failed",completedAt=now().toISOString();await repo.update(operation.id,{targetResults:targets,status,completedAt,updatedAt:completedAt});return{operation:(await repo.getById(operation.id))!,productUpdatedAtBefore:before,productUpdatedAtAfter:before};}
 const current=await getProductById(db,operation.productId),clearBefore=current.updatedAt,after=new Date(Math.max(Date.now(),Date.parse(clearBefore)+1)).toISOString();if(!await repo.clearSalePause(operation.productId,current.salePausedAt!,after))throw new ConflictError("Product pause state changed during Relist");const completedAt=now().toISOString();await repo.update(operation.id,{targetResults:targets,status:"succeeded",completedAt,updatedAt:completedAt});return{operation:(await repo.getById(operation.id))!,productUpdatedAtBefore:clearBefore,productUpdatedAtAfter:after};
}
export async function relistProduct(db:DbClient,input:{productId:string;actorAdminUserId:string;idempotencyKey:string;reason?:string},adapterResolver:AdapterResolver=getAdapter){const operation=await beginProductRelist(db,input);return processRelistOperation(db,operation,adapterResolver);}
export async function retryLifecycleOperation(db:DbClient,productId:string,operationId:string,adapterResolver:AdapterResolver=getAdapter){const repo=createProductLifecycleRepository(db),operation=await repo.getById(operationId);if(!operation||operation.productId!==productId)throw new NotFoundError("Lifecycle operation not found");if(operation.action==="pause")return retryPauseOperation(db,productId,operationId,adapterResolver);const reset=operation.targetResults.map(t=>t.status==="failed"&&t.retryable!==false?finished(t,{status:"pending",error:undefined,retryable:undefined}):t);await repo.update(operation.id,{targetResults:reset,status:"processing",completedAt:null});return processRelistOperation(db,(await repo.getById(operation.id))!,adapterResolver);}
