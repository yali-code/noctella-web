import { MarketplaceConnectionStatus, PublishChannel, type ProductLifecycleOperation, type ProductLifecycleResult, type ProductLifecycleTarget } from "@noctella/shared";
import type { MarketplaceAdapter } from "./marketplaceAdapters";
import type { DbClient } from "../db/client";
import { createProductLifecycleRepository } from "../repositories/product-lifecycle/factory";
import { productLifecycleSchema } from "../repositories/product-lifecycle/schema";
import { beginProductPause, isTerminalExternalListingStatus, type BeginProductPauseInput } from "../use-cases/product-lifecycle/useCases";
import { decryptCredential } from "./credentialEncryption";
import { ConflictError, NotFoundError } from "./errors";
import { getAdapter, sanitizeMarketplaceError } from "./marketplacePublishing";
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
