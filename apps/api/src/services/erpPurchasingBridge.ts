import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { LandedCostAllocationMethod, PurchaseSourceType, PurchaseStatus, SupplierStatus, SupplierType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { erpCommandExecutions, products, purchaseAllocations, purchaseEvents, purchaseLines, purchaseReceiptLines, purchaseReceipts, purchases, suppliers } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { enqueueProductStockSync } from "./stockSync";
import { receivePurchaseUseCase } from "../application/purchase";
import { createPurchaseApplicationContextForDb } from "./purchaseApplicationContextForDb";

type Db = DbClient | any;
const now = () => new Date().toISOString();
export const normalizeSupplierName = (name: string) => name.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
const num = (v: unknown) => v == null ? null : Number(v);
const checksum = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
function assertEur(currency?: string|null) { if (currency && currency !== "EUR") throw new BadRequestError("Purchasing accounting is EUR only"); }
function redactedSupplier(s: any) { return { ...s, email: s.email ? "[redacted]" : null, phone: s.phone ? "[redacted]" : null }; }
/** Sprint 48B: same policy value as Sprint 46B/47B, kept local so this file's command lifecycle stays self-contained. */
const ERP_PURCHASING_COMMAND_ACCEPTED_STALE_MS = 60_000;
function safeErrorCodeFor(error:unknown):string{ if(error instanceof BadRequestError) return "BadRequestError"; if(error instanceof ConflictError) return "ConflictError"; if(error instanceof NotFoundError) return "NotFoundError"; return "InternalError"; }
async function startCommand(db: DbClient, clientId: string, env: any, commandType: string, entityType: string, entityId?: string): Promise<{ replay:boolean; result?:any }> {
  const sum=checksum(env.payload ?? env); const key=env.idempotencyKey;
  if(!key) throw new BadRequestError("idempotencyKey is required");
  const [existing]=await db.select().from(erpCommandExecutions).where(and(eq(erpCommandExecutions.clientId, clientId), eq(erpCommandExecutions.idempotencyKey, key))).limit(1);
  if(existing){
    if(existing.requestChecksum!==sum) throw new ConflictError("Idempotency key was already used with a different payload");
    if(existing.status==="Completed") return { replay:true, result:{ status:existing.status, entityId:existing.entityId, resultReference:existing.resultReference, safeResultMetadata: existing.safeResultMetadata ? JSON.parse(existing.safeResultMetadata) : undefined } };
    if(existing.status==="Accepted"){
      const isStale=Date.now()-new Date(existing.createdAt).getTime()>ERP_PURCHASING_COMMAND_ACCEPTED_STALE_MS;
      if(!isStale) throw new ConflictError("ERP command is already in progress");
    }
    // Stale Accepted or Failed: reuse the same row rather than inserting a duplicate.
    await db.update(erpCommandExecutions).set({status:"Accepted",safeErrorCode:null,completedAt:null,createdAt:now()}).where(and(eq(erpCommandExecutions.clientId,clientId),eq(erpCommandExecutions.idempotencyKey,key)));
    return { replay:false };
  }
  try {
    await db.insert(erpCommandExecutions).values({ id:randomUUID(), clientId, commandId:env.commandId ?? key, requestId:env.requestId ?? null, idempotencyKey:key, commandType, entityType, entityId:entityId ?? null, status:"Accepted", requestChecksum:sum, createdAt:now() });
  } catch (error:any) {
    // Concurrent first-call collision: someone else already claimed this key. Re-read and apply normal rules instead of surfacing the raw UNIQUE error.
    if(String(error?.message??error).includes("UNIQUE constraint failed")) return startCommand(db,clientId,env,commandType,entityType,entityId);
    throw error;
  }
  return { replay:false };
}
async function finishCommand(db:DbClient, clientId:string, key:string, status:string, entityId:string|null, meta:any, error?:string) { await db.update(erpCommandExecutions).set({ status, entityId, resultReference:entityId, safeResultMetadata:JSON.stringify(meta ?? {}), safeErrorCode:error ?? null, completedAt:now() }).where(and(eq(erpCommandExecutions.clientId, clientId), eq(erpCommandExecutions.idempotencyKey, key))); }
async function failCommand(db:DbClient, clientId:string, key:string, error:unknown) { await db.update(erpCommandExecutions).set({ status:"Failed", safeErrorCode:safeErrorCodeFor(error), completedAt:now() }).where(and(eq(erpCommandExecutions.clientId, clientId), eq(erpCommandExecutions.idempotencyKey, key))); }
export async function createSupplier(db: Db, input: any) { const name=String(input.name ?? "").trim(); if(!name) throw new BadRequestError("Supplier name is required"); const n=normalizeSupplierName(name); if(input.erpReferenceId){ const [e]=await db.select().from(suppliers).where(eq(suppliers.erpReferenceId,String(input.erpReferenceId))).limit(1); if(e) throw new ConflictError("Supplier ERP reference already exists"); } const rows=await db.select().from(suppliers).where(and(eq(suppliers.normalizedName,n), input.countryCode == null ? sql`${suppliers.countryCode} IS NULL` : eq(suppliers.countryCode,input.countryCode))).limit(2); if(rows.length) throw new ConflictError("Supplier candidate already exists; explicit update required"); const t=now(); const row={ id:randomUUID(), erpReferenceId:input.erpReferenceId ?? null, name, normalizedName:n, supplierType:input.supplierType ?? SupplierType.Other, countryCode:input.countryCode ?? null, city:input.city ?? null, email:input.email ?? null, phone:input.phone ?? null, website:input.website ?? null, taxNumber:input.taxNumber ?? null, notes:input.notes ?? null, status:input.status ?? SupplierStatus.Active, createdAt:t, updatedAt:t }; await db.insert(suppliers).values(row); return row; }
export async function updateSupplier(db:Db, id:string, input:any) { const [s]=await db.select().from(suppliers).where(eq(suppliers.id,id)).limit(1); if(!s) throw new NotFoundError("Supplier not found"); if(input.expectedUpdatedAt && input.expectedUpdatedAt !== s.updatedAt) throw new ConflictError("Supplier has changed since expectedUpdatedAt"); const patch:any={ updatedAt:now() }; for(const k of ["name","supplierType","countryCode","city","email","phone","website","taxNumber","notes","status"]){ if(input[k]!==undefined) patch[k]=input[k]; } if(patch.name){ if(!String(patch.name).trim()) throw new BadRequestError("Supplier name is required"); patch.normalizedName=normalizeSupplierName(patch.name); } await db.update(suppliers).set(patch).where(eq(suppliers.id,id)); return getSupplier(db,id,true); }
export async function getSupplier(db:Db,id:string, includePii=false){ const [s]=await db.select().from(suppliers).where(eq(suppliers.id,id)).limit(1); if(!s) throw new NotFoundError("Supplier not found"); return includePii?s:redactedSupplier(s); }
export async function listSuppliers(db:Db,q:any={}){ const filters=[]; if(q.status) filters.push(eq(suppliers.status,String(q.status))); if(q.search) filters.push(like(suppliers.normalizedName, `%${normalizeSupplierName(String(q.search))}%`)); const where=filters.length?and(...filters):undefined; const page=Number(q.page??1), pageSize=Number(q.pageSize??50); const rows=await db.select().from(suppliers).where(where).orderBy(suppliers.name).limit(pageSize).offset((page-1)*pageSize); return { items: rows.map(redactedSupplier), page, pageSize }; }
export async function findSupplierByErpReference(db:Db, ref:string){ const [s]=await db.select().from(suppliers).where(eq(suppliers.erpReferenceId,ref)).limit(1); return s??null; }
export async function findSupplierCandidates(db:Db, name:string, countryCode?:string){ return db.select().from(suppliers).where(and(eq(suppliers.normalizedName,normalizeSupplierName(name)), countryCode == null ? sql`${suppliers.countryCode} IS NULL` : eq(suppliers.countryCode,countryCode))).limit(10); }
export const deactivateSupplier=(db:Db,id:string)=>updateSupplier(db,id,{status:SupplierStatus.Inactive}); export const reactivateSupplier=(db:Db,id:string)=>updateSupplier(db,id,{status:SupplierStatus.Active});
function totalOf(p:any){ const vals=[p.itemSubtotal,p.buyerPremium,p.shippingCost,p.customsCost,p.packagingCost,p.taxVat,p.miscellaneousCost]; return vals.some(v=>v==null)?null:vals.reduce((a,v)=>a+Number(v),0); }
/**
 * Sprint 48B: the purchase insert, its line inserts, and the Created event
 * insert now run inside one synchronous db.transaction() so they commit or
 * roll back together — a failure partway through no longer leaves a purchase
 * with fewer lines than requested. Validation and the erpReferenceId
 * uniqueness read stay outside the transaction (pure checks, no writes yet).
 * The event insert is inlined with sync terminal methods rather than reusing
 * the async event() helper, which cannot be awaited inside a sync callback.
 */
export async function createPurchase(db:Db,input:any){ assertEur(input.currency); if(!input.lines?.length) throw new BadRequestError("Purchase requires at least one line"); if(input.erpReferenceId){ const [e]=await db.select().from(purchases).where(eq(purchases.erpReferenceId,String(input.erpReferenceId))).limit(1); if(e) throw new ConflictError("Purchase ERP reference already exists"); } const t=now(); const itemSubtotal=input.lines.reduce((a:any,l:any)=>{ if(!Number.isInteger(l.quantity)||l.quantity<=0) throw new BadRequestError("Purchase line quantity must be a positive integer"); if(Number(l.unitPurchaseCost)<0) throw new BadRequestError("Purchase cost cannot be negative"); return a+Number(l.quantity)*Number(l.unitPurchaseCost); },0); const id=randomUUID(); const row:any={ id, erpReferenceId:input.erpReferenceId??null, supplierId:input.supplierId??null, sourceType:input.sourceType??PurchaseSourceType.Other, externalReference:input.externalReference??null, invoiceReferenceNumber:input.invoiceReferenceNumber??null, auctionHouse:input.auctionHouse??null, auctionDate:input.auctionDate??null, currency:"EUR", itemSubtotal, buyerPremium:num(input.buyerPremium), shippingCost:num(input.shippingCost), customsCost:num(input.customsCost), packagingCost:num(input.packagingCost), taxVat:num(input.taxVat), miscellaneousCost:num(input.miscellaneousCost), totalCost:null as number|null, status:input.status??PurchaseStatus.Draft, orderedAt:input.orderedAt??null, receivedAt:null, notes:input.notes??null, createdAt:t, updatedAt:t }; row.totalCost=totalOf(row);
  db.transaction((tx:any) => {
    tx.insert(purchases).values(row).run();
    for(const l of input.lines) tx.insert(purchaseLines).values({ id:randomUUID(), purchaseId:id, productId:l.productId??null, sourceLineReference:l.sourceLineReference??null, titleSnapshot:l.titleSnapshot, quantity:l.quantity, receivedQuantity:0, unitPurchaseCost:l.unitPurchaseCost, weight:l.weight??null, manualAllocatedCost:l.manualAllocatedCost??null, createdAt:t, updatedAt:t }).run();
    tx.insert(purchaseEvents).values({ id:randomUUID(), purchaseId:id, eventType:"Created", safeMetadata:JSON.stringify({ sourceType:row.sourceType }), createdAt:t }).run();
  });
  return getPurchase(db,id); }
export async function getPurchase(db:Db,id:string){ const [p]=await db.select().from(purchases).where(eq(purchases.id,id)).limit(1); if(!p) throw new NotFoundError("Purchase not found"); const lines=await db.select().from(purchaseLines).where(eq(purchaseLines.purchaseId,id)); const allocations=await db.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId,id)); const receipts=await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseId,id)); return { ...p, lines, allocations, receipts }; }
export async function listPurchases(db:Db,q:any={}){ const filters=[]; if(q.status) filters.push(eq(purchases.status,String(q.status))); if(q.supplierId) filters.push(eq(purchases.supplierId,String(q.supplierId))); if(q.sourceType) filters.push(eq(purchases.sourceType,String(q.sourceType))); const where=filters.length?and(...filters):undefined; const page=Number(q.page??1), pageSize=Number(q.pageSize??50); return { items: await db.select().from(purchases).where(where).orderBy(desc(purchases.createdAt)).limit(pageSize).offset((page-1)*pageSize), page, pageSize }; }
export async function updatePurchase(db:Db,id:string,input:any){ const [p]=await db.select().from(purchases).where(eq(purchases.id,id)).limit(1); if(!p) throw new NotFoundError("Purchase not found"); if(input.expectedUpdatedAt && input.expectedUpdatedAt!==p.updatedAt) throw new ConflictError("Purchase has changed since expectedUpdatedAt"); assertEur(input.currency); const patch:any={updatedAt:now()}; for(const k of ["supplierId","sourceType","externalReference","invoiceReferenceNumber","auctionHouse","auctionDate","buyerPremium","shippingCost","customsCost","packagingCost","taxVat","miscellaneousCost","notes"]){ if(input[k]!==undefined) patch[k]=input[k]; } patch.totalCost=totalOf({...p,...patch}); await db.update(purchases).set(patch).where(eq(purchases.id,id)); await event(db,id,"Updated",{fields:Object.keys(patch)}); return getPurchase(db,id); }
export async function cancelPurchase(db:Db,id:string){ await db.update(purchases).set({status:PurchaseStatus.Cancelled,updatedAt:now()}).where(eq(purchases.id,id)); await event(db,id,"Cancelled",{}); return getPurchase(db,id); }
export async function markOrdered(db:Db,id:string){ await db.update(purchases).set({status:PurchaseStatus.Ordered,orderedAt:now(),updatedAt:now()}).where(eq(purchases.id,id)); return getPurchase(db,id); }
function cents(v:number){ return Math.round(v*100); } function money(c:number){ return Number((c/100).toFixed(2)); }
function split(total:number|null|undefined, weights:number[]){ if(total==null) return weights.map(()=>null); if(total<0) throw new BadRequestError("Negative costs are not allowed"); const c=cents(total), sum=weights.reduce((a,b)=>a+b,0); let used=0; return weights.map((w,i)=>{ const x=i===weights.length-1?c-used:Math.floor(c*(sum?w/sum:1/weights.length)); used+=x; return money(x); }); }
/**
 * Sprint 48B: the destructive delete-and-replace sequence (clear existing
 * allocations, insert the new set, log the event) now runs inside one
 * synchronous db.transaction(). Previously a failure partway through the
 * insert loop could leave the purchase with zero or partial allocations,
 * since the prior set was already deleted with no way back. Now any failure
 * rolls the delete back too, so the original allocation set is restored
 * exactly. Loading the purchase, the Received-status guard, and computing
 * the new allocation rows are pure reads/computation and stay outside the
 * transaction; only the destructive writes are wrapped.
 */
export async function allocatePurchaseCosts(db:Db,id:string,cmd:any){ const p=await getPurchase(db,id); if(p.status===PurchaseStatus.Received) throw new ConflictError("Finalized received allocation cannot be silently rewritten"); const lines=p.lines; const method=cmd.allocationMethod??LandedCostAllocationMethod.Equal; const weights=method===LandedCostAllocationMethod.ByItemCost?lines.map((l:any)=>l.quantity*l.unitPurchaseCost):method===LandedCostAllocationMethod.ByQuantity?lines.map((l:any)=>l.quantity):method===LandedCostAllocationMethod.ByWeight?lines.map((l:any)=>l.weight??0):lines.map(()=>1); const comps:any={allocatedShippingCost:split(p.shippingCost,weights),allocatedCustomsCost:split(p.customsCost,weights),allocatedPackagingCost:split(p.packagingCost,weights),allocatedBuyerPremium:split(p.buyerPremium,weights),allocatedMiscCost:split(p.miscellaneousCost,weights),allocatedTaxVat:split(p.taxVat,weights)};
  const t=now();
  const newRows=lines.map((line:any,i:number)=>{ const base=lines[i].quantity*lines[i].unitPurchaseCost; const extra=(Object.values(comps) as Array<Array<number|null>>).reduce((a,arr)=>a+(arr[i]??0),0); return { id:randomUUID(), purchaseId:id, purchaseLineId:lines[i].id, productId:lines[i].productId, allocationMethod:method, allocatedShippingCost:comps.allocatedShippingCost[i], allocatedCustomsCost:comps.allocatedCustomsCost[i], allocatedPackagingCost:comps.allocatedPackagingCost[i], allocatedBuyerPremium:comps.allocatedBuyerPremium[i], allocatedMiscCost:comps.allocatedMiscCost[i], allocatedTaxVat:comps.allocatedTaxVat[i], allocatedTotalCost:money(cents(base+extra)), createdAt:t, updatedAt:t }; });
  db.transaction((tx:any) => {
    tx.delete(purchaseAllocations).where(eq(purchaseAllocations.purchaseId,id)).run();
    for(const row of newRows) tx.insert(purchaseAllocations).values(row).run();
    tx.insert(purchaseEvents).values({ id:randomUUID(), purchaseId:id, eventType:"Allocated", safeMetadata:JSON.stringify({allocationMethod:method}), createdAt:t }).run();
  });
  return getPurchaseLandedCostSummary(db,id); }
export async function recalculatePurchaseTotals(db:Db,id:string){ const p=await getPurchase(db,id); const total=totalOf(p); await db.update(purchases).set({totalCost:total,updatedAt:now()}).where(eq(purchases.id,id)); return getPurchase(db,id); }
export async function receivePurchase(db:Db,id:string,cmd:any){
  const driver = process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres" ? process.env.DATABASE_DRIVER : "sqlite";
  const result = await receivePurchaseUseCase(
    createPurchaseApplicationContextForDb({ db, driver }),
  ).execute({ ...cmd, purchaseId: id });
  if (!result.replayed) {
    await event(db, id, "Received", { lineCount: cmd.lines.length });
    const receivedLineIds = new Set(cmd.lines.map((line: any) => line.purchaseLineId));
    for (const productId of [...new Set(result.purchase.lines.filter((line) => line.productId && receivedLineIds.has(line.id)).map((line) => line.productId!))])
      await enqueueProductStockSync(db, productId, `purchase-receipt:${cmd.idempotencyKey}:${productId}`);
  }
  return result.purchase;
}
export async function getPurchaseEvents(db:Db,id:string){ return db.select().from(purchaseEvents).where(eq(purchaseEvents.purchaseId,id)).orderBy(purchaseEvents.createdAt); }
export async function getPurchaseLandedCostSummary(db:Db,id:string){ const p=await getPurchase(db,id); const lines=p.lines.map((l:any)=>{ const a=p.allocations.find((x:any)=>x.purchaseLineId===l.id); const total=a?.allocatedTotalCost??null; return { purchaseLineId:l.id, productId:l.productId, baseItemCost:l.quantity*l.unitPurchaseCost, allocatedBuyerPremium:a?.allocatedBuyerPremium??null, allocatedShipping:a?.allocatedShippingCost??null, allocatedCustoms:a?.allocatedCustomsCost??null, allocatedPackaging:a?.allocatedPackagingCost??null, allocatedTaxVat:a?.allocatedTaxVat??null, allocatedMiscellaneous:a?.allocatedMiscCost??null, landedUnitCost:total==null?null:money(cents(total/l.quantity)), landedTotalCost:total, complete:!!a && p.totalCost!=null }; }); const allocated=lines.every((l:any)=>l.landedTotalCost!=null)?money(lines.reduce((a:any,l:any)=>a+cents(l.landedTotalCost),0)):null; return { purchaseId:id, currency:"EUR", allocationMethod:p.allocations[0]?.allocationMethod??LandedCostAllocationMethod.Equal, complete:p.totalCost!=null && allocated!=null, reconciled:p.totalCost==null||allocated==null?false:cents(p.totalCost)===cents(allocated), totalCost:p.totalCost, allocatedTotal:allocated, lines }; }
export async function productPurchaseHistory(db:Db,productId:string){ const lines=await db.select().from(purchaseLines).where(eq(purchaseLines.productId,productId)); const items=[]; for(const line of lines){ const purchase=await getPurchase(db,line.purchaseId); const supplier=purchase.supplierId?await getSupplier(db,purchase.supplierId).catch(()=>null):null; items.push({ purchase, supplier, purchaseLine:line, allocation:purchase.allocations.find((a:any)=>a.purchaseLineId===line.id)??null, receiptStatus:purchase.status, landedCost:(await getPurchaseLandedCostSummary(db,purchase.id)).lines.find((x:any)=>x.purchaseLineId===line.id), sourceReferences:{erpReferenceId:purchase.erpReferenceId,externalReference:purchase.externalReference,invoiceReferenceNumber:purchase.invoiceReferenceNumber}, dates:{orderedAt:purchase.orderedAt,receivedAt:purchase.receivedAt} }); } return { productId, items }; }
async function event(db:Db,purchaseId:string,eventType:string,safeMetadata:any){ await db.insert(purchaseEvents).values({id:randomUUID(),purchaseId,eventType,safeMetadata:JSON.stringify(safeMetadata??{}),createdAt:now()}); }
export async function executeSupplierCommand(db:DbClient, clientId:string, env:any, id?:string){
  const type=id?"UpdateSupplier":"CreateSupplier";
  const started=await startCommand(db,clientId,env,type,"Supplier",id);
  if(started.replay) return started.result;
  let out:any;
  try {
    out=id?await updateSupplier(db,id,env.payload??{}):await createSupplier(db,env.payload??{});
  } catch (error) {
    await failCommand(db,clientId,env.idempotencyKey,error);
    throw error;
  }
  await finishCommand(db,clientId,env.idempotencyKey,"Completed",out.id,{supplierId:out.id, erpReferenceId:out.erpReferenceId});
  return out;
}
export async function executePurchaseCommand(db:DbClient, clientId:string, env:any, action:string, id?:string){
  const started=await startCommand(db,clientId,env,action,"Purchase",id);
  if(started.replay) return started.result;
  const p=env.payload??{};
  let out:any;
  try {
    out= action==="CreatePurchase"?await createPurchase(db,p):action==="UpdatePurchase"?await updatePurchase(db,id!,p):action==="AllocatePurchaseCosts"?await allocatePurchaseCosts(db,id!,p):action==="ReceivePurchase"?await receivePurchase(db,id!,{...p,idempotencyKey:p.idempotencyKey??env.idempotencyKey}):action==="CancelPurchase"?await cancelPurchase(db,id!):null;
  } catch (error) {
    await failCommand(db,clientId,env.idempotencyKey,error);
    throw error;
  }
  await finishCommand(db,clientId,env.idempotencyKey,"Completed",(out as any).id??id,{purchaseId:(out as any).id??id, action});
  return out;
}
