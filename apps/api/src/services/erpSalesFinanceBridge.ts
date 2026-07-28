import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { assertValidNumberIfPresent, calculateInvoiceTotals, ErpInvoiceCalculationMode, ErpInvoiceStatus, ErpInvoiceTaxTreatment, ErpInvoiceType, InvoiceCalculationError, NumericValidationError, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { erpCommandExecutions, financeEntries, invoiceEvents, invoiceLines, invoices, marketplaceOrders, orderItems, orders, products, refunds, saleFinancials, saleReversals, shipments } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { createFinanceEntry, createFinanceEntrySync } from "./financePostings";
import { completeSale, getSaleCompletionReadiness } from "./shipments";
import { createSalesServiceApplication } from "./salesServiceApplication";
import type { SaleOutput } from "../application/sales";
import { getCompanyProfile } from "./companyProfile";
const now=()=>new Date().toISOString(); const money=(n:number)=>Number(n.toFixed(2)); const sum=(p:unknown)=>createHash("sha256").update(JSON.stringify(p??{})).digest("hex");
function parse(v:any,d:any=null){try{return v?JSON.parse(v):d}catch{return d}} function mask(e:string|null|undefined){if(!e)return null; const [a,b]=e.split("@"); return `${a.slice(0,2)}***@${b??"masked"}`}
/** Sprint 46B: an Accepted row older than this is treated as abandoned (crashed/never-finished), not genuinely in-flight — commands here run synchronously within one request, so anything still Accepted after this long is not a real in-progress attempt. */
export const ERP_COMMAND_ACCEPTED_STALE_MS = 60_000;
/** Sprint 79 correction: maps the shared NumericValidationError (NaN/Infinity/non-numeric-string/out-of-range) to this service's BadRequestError, so malformed numeric ERP input is rejected with a 400 instead of silently becoming NaN or the original garbage value. */
function numeric(value:unknown, fieldName:string, options:{min?:number,max?:number,integer?:boolean}={}){ try { return assertValidNumberIfPresent(value, fieldName, options); } catch (error) { if (error instanceof NumericValidationError) throw new BadRequestError(error.message); throw error; } }
function safeErrorCodeFor(error:unknown):string{ if(error instanceof BadRequestError) return "BadRequestError"; if(error instanceof ConflictError) return "ConflictError"; if(error instanceof NotFoundError) return "NotFoundError"; return "InternalError"; }
async function command(db:DbClient,clientId:string,env:any,type:string,entityType:string,entityId?:string){
  if(!env?.idempotencyKey) throw new BadRequestError("idempotencyKey is required");
  const checksum=sum(env.payload??env);
  const [e]=await db.select().from(erpCommandExecutions).where(and(eq(erpCommandExecutions.clientId,clientId),eq(erpCommandExecutions.idempotencyKey,env.idempotencyKey))).limit(1);
  if(e){
    if(e.requestChecksum!==checksum) throw new ConflictError("Idempotency key was already used with a different payload");
    if(e.status==="Completed") return {replay:true,result:{status:e.status,entityId:e.entityId,resultReference:e.resultReference,safeResultMetadata:parse(e.safeResultMetadata,{})}};
    if(e.status==="Accepted"){
      const isStale=Date.now()-new Date(e.createdAt).getTime()>ERP_COMMAND_ACCEPTED_STALE_MS;
      if(!isStale) throw new ConflictError("ERP command is already in progress");
    }
    // Stale Accepted or Failed: reuse the same row rather than inserting a duplicate.
    // createdAt is refreshed too (not just status/safeErrorCode/completedAt) so a
    // genuinely concurrent request arriving during this retry sees a *recent*
    // Accepted row and is correctly rejected, not treated as stale itself.
    await db.update(erpCommandExecutions).set({status:"Accepted",safeErrorCode:null,completedAt:null,createdAt:now()}).where(and(eq(erpCommandExecutions.clientId,clientId),eq(erpCommandExecutions.idempotencyKey,env.idempotencyKey)));
    return {replay:false};
  }
  await db.insert(erpCommandExecutions).values({id:randomUUID(),clientId,commandId:env.commandId??env.idempotencyKey,requestId:env.requestId??null,idempotencyKey:env.idempotencyKey,commandType:type,entityType,entityId:entityId??null,status:"Accepted",requestChecksum:checksum,createdAt:now()});
  return {replay:false};
}
async function finish(db:DbClient,clientId:string,key:string,status:string,entityId:string|null,meta:any){ await db.update(erpCommandExecutions).set({status,entityId,resultReference:entityId,safeResultMetadata:JSON.stringify(meta??{}),completedAt:now()}).where(and(eq(erpCommandExecutions.clientId,clientId),eq(erpCommandExecutions.idempotencyKey,key))); }
async function failCommand(db:DbClient,clientId:string,key:string,error:unknown){ await db.update(erpCommandExecutions).set({status:"Failed",safeErrorCode:safeErrorCodeFor(error),completedAt:now()}).where(and(eq(erpCommandExecutions.clientId,clientId),eq(erpCommandExecutions.idempotencyKey,key))); }
async function orderCore(db:DbClient,id:string){ const [o]=await db.select().from(orders).where(eq(orders.id,id)); if(!o) throw new NotFoundError("Order not found"); const items=await db.select().from(orderItems).where(eq(orderItems.orderId,id)); return {o,items}; }
export async function customerProjection(db:DbClient, orderId:string, detail=false){ const {o}=await orderCore(db,orderId); const billing=parse(o.billingAddress,{}), shipping=parse(o.shippingAddress,{}); const name=billing.name??shipping.name??null; return {id:o.customerId,guest:!o.customerId,email:detail?o.guestEmail:null,maskedEmail:mask(o.guestEmail),name,billingAddress:detail?billing:undefined,shippingAddress:detail?shipping:undefined}; }
export async function adjustedFinancials(db:DbClient, orderId:string){ const {o,items}=await orderCore(db,orderId); const [sf]=await db.select().from(saleFinancials).where(eq(saleFinancials.orderId,orderId)); const [{totalRefunded}]=await db.select({totalRefunded:sql<number>`coalesce(sum(${refunds.totalAmount}),0)`}).from(refunds).where(and(eq(refunds.orderId,orderId),eq(refunds.status,"succeeded"))); const requiredKnown=!!sf && sf.shippingCost!=null && sf.itemCost!=null; const gross=sf?.grossRevenue??o.totalAmount; const shippingCost=sf?.shippingCost??null; const itemCost=sf?.itemCost??items.reduce((a,i)=>a,0); const fees=[sf?.marketplaceFee,sf?.promotedFee,sf?.paymentFee]; const feesKnown=fees.every(v=>v!=null); const net=sf?sf.netRevenue:money(o.totalAmount-o.taxAmount-(shippingCost??0)-(feesKnown?fees.reduce((a,v)=>a+Number(v),0):0)); return {currency:"EUR",grossRevenue:gross,shippingCharged:o.shippingAmount,discounts:0,taxVat:o.taxAmount,marketplaceFee:sf?.marketplaceFee??null,promotedFee:sf?.promotedFee??null,paymentFee:sf?.paymentFee??null,shippingCost,itemCost,netRevenue:requiredKnown?net:null,profit:sf?.profit??null,completeness:requiredKnown?"Complete":"Incomplete",totalRefunded:totalRefunded??0,feeAdjustments:null,netRetainedRevenue:requiredKnown?money(net-(totalRefunded??0)):null,adjustedProfit:sf?.profit!=null?money(sf.profit-(totalRefunded??0)):null,adjustedCompleteness:requiredKnown?"Complete":"Incomplete"}; }
async function projectSale(db:DbClient,sale:SaleOutput){ const id=sale.id; const [mo]=await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId,id)); const [sh]=await db.select().from(shipments).where(eq(shipments.orderId,id)).orderBy(desc(shipments.createdAt)).limit(1); const [inv]=await db.select().from(invoices).where(eq(invoices.orderId,id)).orderBy(desc(invoices.createdAt)).limit(1); return {centralOrderId:id,marketplaceOrderId:mo?.id??null,channel:mo?.channel??sale.marketplace.channel??"Internal",orderNumber:sale.reference,customer:await customerProjection(db,id,false),saleDate:sale.createdAt,paymentStatus:sale.paymentStatus,orderStatus:sale.status,shipmentStatus:sh?.status??null,completionStatus:sale.status===OrderStatus.Completed?"Completed":"Open",items:sale.lines.map(i=>({orderItemId:i.id,productId:i.productId,sku:i.sku,title:i.title,quantity:i.quantity,unitPrice:i.unitPrice,lineTotal:i.totalPrice,itemCost:null})),financials:await adjustedFinancials(db,id),invoiceStatus:inv?.status??null,invoiceNumber:inv?.invoiceNumber??null,updatedAt:sale.updatedAt}; }
export async function saleProjection(db:DbClient, id:string){ return projectSale(db,await createSalesServiceApplication(db).getSale.execute({saleId:id})); }
export async function listSales(db:DbClient,q:any={}){ const page=Number(q.page??1),pageSize=Number(q.pageSize??50),application=createSalesServiceApplication(db); if(q.search){const filters:any[]=[like(orders.orderNumber,`%${q.search}%`)];if(q.orderStatus)filters.push(eq(orders.status,String(q.orderStatus)));if(q.paymentStatus)filters.push(eq(orders.paymentStatus,String(q.paymentStatus)));const rows=await db.select({id:orders.id}).from(orders).where(and(...filters)).orderBy(desc(orders.createdAt)).limit(pageSize).offset((page-1)*pageSize);return{items:await Promise.all(rows.map(async row=>projectSale(db,await application.getSale.execute({saleId:row.id})))),page,pageSize};} const result=await application.listSales.execute({status:q.orderStatus,paymentStatus:q.paymentStatus,limit:pageSize,offset:(page-1)*pageSize}); return {items:await Promise.all(result.rows.map(row=>projectSale(db,row))),page,pageSize}; }
export async function createInternalSale(db:DbClient,input:any){ if(!["Internal","Direct","LocalPickup","Other"].includes(input.channel)) throw new BadRequestError("Marketplace impersonation is not allowed"); if(input.currency!==PriceCurrency.Eur) throw new BadRequestError("EUR only"); const addr=input.customer?.address??{fullName:input.customer?.name??"Guest",line1:"ERP internal sale",city:"N/A",postalCode:"N/A",country:"N/A"}; const orderDraftId=input.orderDraftId??`erp-${randomUUID()}`; return createSalesServiceApplication(db).createInternalSale.execute({orderDraftId,idempotencyKey:orderDraftId,channel:"Internal",customerId:input.customer?.id,guestEmail:input.customer?.email??"guest@example.invalid",status:OrderStatus.Processing,paymentStatus:input.paymentStatus??PaymentStatus.Paid,paymentProvider:PaymentProvider.CashOnDelivery,paymentReference:input.paymentReference??"erp-internal",currency:PriceCurrency.Eur,billingAddress:addr,shippingAddress:addr,subtotalAmount:input.subtotalAmount,totalAmount:input.totalAmount,items:input.lines.map((l:any)=>({productId:l.productId,quantity:l.quantity??1})),notes:input.notes}); }
/** Sprint 79: point-in-time seller identity copied onto every new invoice draft — never a live reference. `{configured:false}` when no company profile has been set up yet; drafts are still allowed to exist in that state, only issuing requires it. */
async function sellerSnapshotFromCompanyProfile(db:DbClient){ const profile:any=await getCompanyProfile(db); if(!profile) return { configured:false }; const { id, createdAt, updatedAt, ...rest }=profile; return { configured:true, ...rest }; }
const TAX_TREATMENTS=new Set(Object.values(ErpInvoiceTaxTreatment) as string[]);
/**
 * Sprint 79: single place that turns invoice-level + line-level inputs into
 * persisted totals, always through the shared @noctella/shared calculation
 * service (never duplicated locally). `lineOverrides` is keyed by existing
 * line id; a line id not present in `existingLines` is ignored. In
 * ManualOverride mode, a line's/shipping's current stored taxVatAmount is fed
 * back in as the manual VAT amount unless the caller's override explicitly
 * replaces it, so unrelated edits (e.g. title, quantity) never silently
 * discard an admin-entered manual VAT amount.
 */
async function applyInvoiceCalculation(db:DbClient, invoiceId:string, lineOverrides:Record<string,any> = {}, invoiceOverrides:any = {}){
  const inv:any=(await db.select().from(invoices).where(eq(invoices.id,invoiceId)).limit(1))[0];
  if(!inv) throw new NotFoundError("Invoice not found");
  const existingLines=await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId,invoiceId));
  const merged={ ...inv, ...invoiceOverrides };
  const manual=merged.calculationMode===ErpInvoiceCalculationMode.ManualOverride;
  let result;
  try {
    result=calculateInvoiceTotals({
      lines: existingLines.map((l:any)=>{ const o=lineOverrides[l.id]??{}; return { quantity:o.quantity??l.quantity, unitPrice:o.unitPrice??l.unitPrice, discountAmount:o.discountAmount??l.discountAmount, vatRate:o.vatRate??l.vatRate, manualVatAmount: manual ? (o.manualVatAmount!==undefined?o.manualVatAmount:l.taxVatAmount) : null }; }),
      discountAmount: merged.discountAmount, shippingAmount: merged.shippingAmount, shippingVatRate: merged.shippingVatRate,
      manualShippingVatAmount: manual ? (invoiceOverrides.manualShippingVatAmount!==undefined?invoiceOverrides.manualShippingVatAmount:merged.shippingVatAmount) : null,
      pricesIncludeVat: merged.pricesIncludeVat,
    });
  } catch (error) {
    // Sprint 79 correction: the shared calc module throws a plain, framework-agnostic
    // InvoiceCalculationError (e.g. invoice discount exceeding the eligible base) — mapped here
    // to the API's own BadRequestError so it surfaces as a 400, not an unmapped 500.
    if (error instanceof InvoiceCalculationError) throw new BadRequestError(error.message);
    throw error;
  }
  const t=now();
  for(let i=0;i<existingLines.length;i++){ const l=existingLines[i]; const o=lineOverrides[l.id]??{}; const r=result.lines[i]; await db.update(invoiceLines).set({ titleSnapshot:o.titleSnapshot??l.titleSnapshot, quantity:r.quantity, unitPrice:r.unitPrice, discountAmount:r.discountAmount, vatRate:r.vatRate, taxVatAmount:r.vatAmount, lineTotal:r.lineTotal }).where(eq(invoiceLines.id,l.id)); }
  const patch:any={ ...invoiceOverrides, subtotal:result.subtotal, discountAmount:result.discountAmount, shippingAmount:result.shippingAmount, shippingVatAmount:result.shippingVatAmount, taxVatAmount:result.taxVatAmount, totalAmount:result.totalAmount, updatedAt:t };
  delete patch.manualShippingVatAmount;
  await db.update(invoices).set(patch).where(eq(invoices.id,invoiceId));
  return getInvoice(db,invoiceId);
}
export async function createInvoiceDraft(db:DbClient,orderId:string,input:any={}){
  const {o,items}=await orderCore(db,orderId);
  if(o.currency!=="EUR") throw new BadRequestError("EUR only");
  numeric(input.discountAmount, "Discount amount", { min: 0 });
  numeric(input.shippingAmount, "Shipping amount", { min: 0 });
  if(input.taxTreatment!=null && !TAX_TREATMENTS.has(input.taxTreatment)) throw new BadRequestError("Invalid tax treatment");
  const invoiceType=input.invoiceType??ErpInvoiceType.SalesInvoice;
  if(input.erpReferenceId){ const [e]=await db.select().from(invoices).where(eq(invoices.erpReferenceId,input.erpReferenceId)).limit(1); if(e) return getInvoice(db,e.id); }
  // Sprint 79: at most one SalesInvoice per order, permanently — idempotent lookup-and-return, not an error, so automatic post-order-creation calls and manual retries both converge on the same draft.
  if(invoiceType===ErpInvoiceType.SalesInvoice){ const [existing]=await db.select().from(invoices).where(and(eq(invoices.orderId,orderId),eq(invoices.invoiceType,ErpInvoiceType.SalesInvoice))).limit(1); if(existing) return getInvoice(db,existing.id); }
  const profile:any=await getCompanyProfile(db);
  const t=now(), id=randomUUID();
  const defaultVatRate=profile?.defaultVatRate ?? 0;
  const pricesIncludeVat=profile?.defaultPricesIncludeVat ?? false;
  const taxTreatment=input.taxTreatment??profile?.defaultTaxTreatment??ErpInvoiceTaxTreatment.StandardVAT;
  const dueAt=input.dueAt ?? (profile?.defaultPaymentTermsDays!=null ? new Date(Date.now()+profile.defaultPaymentTermsDays*86_400_000).toISOString() : null);
  // Pure async reads only above this line (order, company profile, snapshots) — no writes yet.
  const sellerSnapshot=JSON.stringify(await sellerSnapshotFromCompanyProfile(db));
  const customerSnapshot=JSON.stringify(await customerProjection(db,orderId,true));
  const invoiceRow={ id, erpReferenceId:input.erpReferenceId??null, orderId, customerId:o.customerId, invoiceNumber:null, invoiceType, status:ErpInvoiceStatus.Draft, currency:"EUR", calculationMode:ErpInvoiceCalculationMode.Automatic, taxTreatment, pricesIncludeVat,
    // Sprint 79 correction: only ever set for SalesInvoice — this is the column the (safe, historical-duplicate-tolerant) unique index actually enforces; see migrate.ts.
    salesInvoiceOrderKey: invoiceType===ErpInvoiceType.SalesInvoice ? orderId : null,
    issuedAt:null, dueAt, paidAt:null, cancelledAt:null, sellerSnapshot, customerSnapshot, billingAddressSnapshot:o.billingAddress, shippingAddressSnapshot:o.shippingAddress, subtotal:0, shippingAmount:o.shippingAmount, shippingVatRate:defaultVatRate, shippingVatAmount:0, discountAmount:input.discountAmount??0, taxVatAmount:0, totalAmount:0, notes:input.notes??null, invoiceFooter:profile?.invoiceFooter??null, sourceSnapshot:JSON.stringify({order:o}), createdAt:t, updatedAt:t };
  const lineRows=items.map((it:any)=>({id:randomUUID(),invoiceId:id,orderItemId:it.id,productId:it.productId,skuSnapshot:it.productSku,titleSnapshot:it.productTitle,quantity:it.quantity,unitPrice:it.unitPrice,discountAmount:0,vatRate:defaultVatRate,taxVatAmount:0,lineTotal:it.totalPrice,createdAt:t}));
  try {
    // Sprint 79 correction: invoice + all its lines + the Created event insert now run inside one
    // synchronous db.transaction() (matching issueInvoice/setInvoiceStatus's existing pattern), so
    // a failed invoice insert (unique-constraint collision) can never leave orphaned invoice_lines
    // — better-sqlite3 rolls the whole transaction back on any thrown error, atomically.
    db.transaction((tx:any) => {
      tx.insert(invoices).values(invoiceRow).run();
      for(const row of lineRows) tx.insert(invoiceLines).values(row).run();
      tx.insert(invoiceEvents).values({id:randomUUID(),invoiceId:id,eventType:"Created",previousStatus:null,newStatus:ErpInvoiceStatus.Draft,safeMetadata:JSON.stringify({orderId}),createdAt:t}).run();
    });
  } catch (error:any) {
    // Sprint 79 correction: checks the *specific* column this transaction can violate
    // ("invoices.sales_invoice_order_key" — SQLite's UNIQUE-violation message names the
    // table.column the offending index covers, not the index itself; verified directly against
    // better-sqlite3's actual error format) rather than a generic "UNIQUE constraint failed"
    // substring, so an unrelated collision (e.g. a concurrent erpReferenceId race, which would say
    // "invoices.erp_reference_id") is never mistaken for "someone else already created the
    // SalesInvoice for this order" — that mistake previously could have fallen through to
    // line-insertion for an invoice that was never actually persisted. An unrelated collision now
    // simply propagates as a real error.
    if(invoiceType===ErpInvoiceType.SalesInvoice && String(error?.message??error).includes("invoices.sales_invoice_order_key")){ const [existing]=await db.select().from(invoices).where(and(eq(invoices.orderId,orderId),eq(invoices.invoiceType,ErpInvoiceType.SalesInvoice))).limit(1); if(existing) return getInvoice(db,existing.id); }
    throw error;
  }
  return applyInvoiceCalculation(db,id);
}
/** Sprint 79: post-order-commit entry point — failures are the caller's responsibility to swallow (see services/orders.ts), matching this codebase's existing post-commit-follow-up convention. */
export async function createAutomaticSalesInvoiceDraft(db:DbClient,orderId:string){ return createInvoiceDraft(db,orderId,{ invoiceType:ErpInvoiceType.SalesInvoice }); }
export async function getInvoice(db:DbClient,id:string){ const [inv]=await db.select().from(invoices).where(eq(invoices.id,id)); if(!inv) throw new NotFoundError("Invoice not found"); return {...inv,lines:await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId,id))}; }
// Sprint 79 correction: explicit column projection excluding sellerSnapshot — since this sprint,
// every SalesInvoice's sellerSnapshot embeds the full company profile (including bankName/iban/bic,
// see sellerSnapshotFromCompanyProfile above) for display on the issued document. A bulk list
// response has no need for that snapshot (the Admin invoice list view never reads it — only the
// single-invoice detail page does, via getInvoice), so it is never included here.
const INVOICE_LIST_COLUMNS = { id:invoices.id, erpReferenceId:invoices.erpReferenceId, orderId:invoices.orderId, customerId:invoices.customerId, invoiceNumber:invoices.invoiceNumber, invoiceType:invoices.invoiceType, status:invoices.status, currency:invoices.currency, calculationMode:invoices.calculationMode, taxTreatment:invoices.taxTreatment, pricesIncludeVat:invoices.pricesIncludeVat, issuedAt:invoices.issuedAt, dueAt:invoices.dueAt, paidAt:invoices.paidAt, cancelledAt:invoices.cancelledAt, subtotal:invoices.subtotal, shippingAmount:invoices.shippingAmount, shippingVatRate:invoices.shippingVatRate, shippingVatAmount:invoices.shippingVatAmount, discountAmount:invoices.discountAmount, taxVatAmount:invoices.taxVatAmount, totalAmount:invoices.totalAmount, createdAt:invoices.createdAt, updatedAt:invoices.updatedAt } as const;
export async function listInvoices(db:DbClient,q:any={}){ const f:any[]=[]; if(q.orderId)f.push(eq(invoices.orderId,String(q.orderId))); if(q.status)f.push(eq(invoices.status,String(q.status))); const rows=await db.select(INVOICE_LIST_COLUMNS).from(invoices).where(f.length?and(...f):undefined).orderBy(desc(invoices.createdAt)).limit(Number(q.pageSize??50)).offset((Number(q.page??1)-1)*Number(q.pageSize??50)); return {items:rows,page:Number(q.page??1),pageSize:Number(q.pageSize??50)}; }
function assertDraftEditable(inv:any){ if(inv.status!==ErpInvoiceStatus.Draft) throw new ConflictError("Issued invoice snapshots are immutable"); }
/**
 * Sprint 79: expanded Draft-only editable-field set. Never accepts
 * invoiceNumber or orderId — neither is read from `input` anywhere below, so
 * a caller-supplied value for either is silently inert rather than needing an
 * explicit rejection branch. Always recalculates totals through
 * applyInvoiceCalculation so an Automatic-mode edit (shipping, discount,
 * pricesIncludeVat, ...) is immediately reflected, and a ManualOverride edit
 * still gets a correct taxableBase/lineTotal recompute around the pinned
 * manual VAT amounts.
 */
export async function updateInvoiceDraft(db:DbClient,id:string,input:any){
  const inv:any=await getInvoice(db,id);
  assertDraftEditable(inv);
  if(input.expectedUpdatedAt && input.expectedUpdatedAt!==inv.updatedAt) throw new ConflictError("Invoice has changed");
  if(input.calculationMode!=null && ![ErpInvoiceCalculationMode.Automatic,ErpInvoiceCalculationMode.ManualOverride].includes(input.calculationMode)) throw new BadRequestError("Invalid calculation mode");
  if(input.taxTreatment!=null && !TAX_TREATMENTS.has(input.taxTreatment)) throw new BadRequestError("Invalid tax treatment");
  numeric(input.shippingAmount, "Shipping amount", { min: 0 });
  numeric(input.discountAmount, "Discount amount", { min: 0 });
  numeric(input.shippingVatRate, "Shipping VAT rate", { min: 0, max: 100 });
  numeric(input.manualShippingVatAmount, "Manual shipping VAT amount");
  const changedFields=Object.keys(input).filter(k=>k!=="expectedUpdatedAt");
  const before:Record<string,unknown>={}; for(const f of changedFields) before[f]=(inv as any)[f];
  const invoiceOverrides:any={};
  for(const f of ["calculationMode","taxTreatment","pricesIncludeVat","shippingAmount","shippingVatRate","discountAmount","dueAt","notes","invoiceFooter"]) if(input[f]!==undefined) invoiceOverrides[f]=input[f];
  if(input.customerSnapshot!==undefined) invoiceOverrides.customerSnapshot=JSON.stringify(input.customerSnapshot);
  if(input.billingAddressSnapshot!==undefined) invoiceOverrides.billingAddressSnapshot=JSON.stringify(input.billingAddressSnapshot);
  if(input.shippingAddressSnapshot!==undefined) invoiceOverrides.shippingAddressSnapshot=JSON.stringify(input.shippingAddressSnapshot);
  if(input.manualShippingVatAmount!==undefined) invoiceOverrides.manualShippingVatAmount=input.manualShippingVatAmount;
  const updated=await applyInvoiceCalculation(db,id,{},invoiceOverrides);
  await invoiceEvent(db,id,"Updated",inv.status,inv.status,{fields:changedFields,before,calculationMode:(updated as any).calculationMode});
  return updated;
}
/** Sprint 79: Draft-only per-line edit. quantity is capped at the linked order item's original quantity so an invoice line can never claim more than what was actually ordered. */
export async function updateInvoiceLine(db:DbClient,invoiceId:string,lineId:string,input:any){
  const inv:any=await getInvoice(db,invoiceId);
  assertDraftEditable(inv);
  const line:any=inv.lines.find((l:any)=>l.id===lineId);
  if(!line) throw new NotFoundError("Invoice line not found");
  if(input.expectedUpdatedAt && input.expectedUpdatedAt!==inv.updatedAt) throw new ConflictError("Invoice has changed");
  if(input.quantity!=null){ numeric(input.quantity, "Line quantity", { integer: true, min: 1 }); if(line.orderItemId){ const [oi]=await db.select().from(orderItems).where(eq(orderItems.id,line.orderItemId)).limit(1); if(oi && input.quantity>oi.quantity) throw new BadRequestError("Line quantity cannot exceed the ordered quantity"); } }
  numeric(input.unitPrice, "Unit price", { min: 0 });
  numeric(input.discountAmount, "Line discount", { min: 0 });
  numeric(input.vatRate, "VAT rate", { min: 0, max: 100 });
  if(input.manualVatAmount!=null){ numeric(input.manualVatAmount, "Manual VAT amount"); if(inv.calculationMode!==ErpInvoiceCalculationMode.ManualOverride) throw new BadRequestError("Manual VAT amount requires ManualOverride calculation mode"); }
  const override:any={}; for(const f of ["titleSnapshot","quantity","unitPrice","discountAmount","vatRate","manualVatAmount"]) if(input[f]!==undefined) override[f]=input[f];
  const before={ titleSnapshot:line.titleSnapshot, quantity:line.quantity, unitPrice:line.unitPrice, discountAmount:line.discountAmount, vatRate:line.vatRate };
  const updated=await applyInvoiceCalculation(db,invoiceId,{[lineId]:override});
  await invoiceEvent(db,invoiceId,"LineUpdated",inv.status,inv.status,{lineId,fields:Object.keys(override),before});
  return updated;
}
/** Sprint 79: explicit mode switch — its own audited event, never a silent side effect of another edit. The already-persisted last-computed line/shipping values are left exactly as they are, so they become ManualOverride's starting point automatically. */
export async function switchInvoiceCalculationMode(db:DbClient,invoiceId:string,mode:string){
  const inv:any=await getInvoice(db,invoiceId);
  assertDraftEditable(inv);
  if(![ErpInvoiceCalculationMode.Automatic,ErpInvoiceCalculationMode.ManualOverride].includes(mode as any)) throw new BadRequestError("Invalid calculation mode");
  const previousMode=inv.calculationMode;
  const updated=await applyInvoiceCalculation(db,invoiceId,{},{calculationMode:mode});
  await invoiceEvent(db,invoiceId,"CalculationModeSwitched",inv.status,inv.status,{previousMode,newMode:mode});
  return updated;
}
/** Sprint 79: explicit "Recalculate" action — re-runs the shared calculation over current inputs with no field changes. Safe/idempotent in both modes (ManualOverride amounts are preserved, see applyInvoiceCalculation). */
export async function recalculateInvoiceDraft(db:DbClient,invoiceId:string){
  const inv:any=await getInvoice(db,invoiceId);
  assertDraftEditable(inv);
  const updated=await applyInvoiceCalculation(db,invoiceId);
  await invoiceEvent(db,invoiceId,"Recalculated",inv.status,inv.status,{});
  return updated;
}
/** Sprint 79: Draft-only, explicit, audited — never invoked implicitly by any other edit, and unavailable once issued (assertDraftEditable). */
export async function refreshInvoiceSellerSnapshot(db:DbClient,invoiceId:string){
  const inv:any=await getInvoice(db,invoiceId);
  assertDraftEditable(inv);
  const snapshot=await sellerSnapshotFromCompanyProfile(db);
  await db.update(invoices).set({sellerSnapshot:JSON.stringify(snapshot),updatedAt:now()}).where(eq(invoices.id,invoiceId));
  await invoiceEvent(db,invoiceId,"SellerSnapshotRefreshed",inv.status,inv.status,{configured:(snapshot as any).configured});
  return getInvoice(db,invoiceId);
}
/**
 * Sprint 79: pure read — validates without mutating, called both by the
 * dedicated readiness endpoint and internally by issueInvoice immediately
 * before the atomic issue transaction. VAT-number requirement is derived
 * from the tax treatment the admin already explicitly selected, never from
 * customer country — see the ErpInvoiceTaxTreatment doc comment.
 */
export async function getInvoiceIssueReadiness(db:DbClient,invoiceId:string){
  const inv:any=await getInvoice(db,invoiceId);
  const issues:string[]=[];
  const profile:any=await getCompanyProfile(db);
  if(!profile) issues.push("Company profile is not configured");
  else {
    for(const [field,label] of [["legalName","legal company name"],["registrationNumber","company registration number"],["addressLine1","registered address"],["city","registered address city"],["postalCode","registered address postal code"],["country","registered address country"],["email","business email"],["phone","business phone"]] as const) if(!String(profile[field]??"").trim()) issues.push(`Company ${label} is missing`);
    if([ErpInvoiceTaxTreatment.StandardVAT,ErpInvoiceTaxTreatment.IntraEUReverseCharge].includes(inv.taxTreatment) && !String(profile.vatNumber??"").trim()) issues.push("Company VAT number is required for the selected tax treatment");
  }
  const customer=inv.customerSnapshot ? JSON.parse(inv.customerSnapshot) : {};
  const billing=inv.billingAddressSnapshot ? JSON.parse(inv.billingAddressSnapshot) : {};
  if(!String(customer?.name??billing?.fullName??billing?.name??"").trim()) issues.push("Customer name is missing");
  if(!String(billing?.line1??"").trim() || !String(billing?.city??"").trim() || !String(billing?.country??"").trim()) issues.push("Customer billing address is incomplete");
  if(!inv.lines?.length) issues.push("Invoice has no lines");
  for(const l of inv.lines??[]) if(l.vatRate<0 || l.vatRate>100 || Number.isNaN(l.vatRate)) issues.push(`Line "${l.titleSnapshot}" has an invalid VAT rate`);
  if(inv.shippingVatRate<0 || inv.shippingVatRate>100 || Number.isNaN(inv.shippingVatRate)) issues.push("Shipping VAT rate is invalid");
  if(inv.totalAmount<0) issues.push("Invoice total cannot be negative");
  if(inv.currency!=="EUR") issues.push("Invoice currency must be EUR");
  return { ready: issues.length===0, issues };
}
export const INVOICE_STATUS_TRANSITIONS: Partial<Record<ErpInvoiceStatus, ErpInvoiceStatus[]>> = { [ErpInvoiceStatus.Draft]:[ErpInvoiceStatus.Issued,ErpInvoiceStatus.Cancelled], [ErpInvoiceStatus.Issued]:[ErpInvoiceStatus.Cancelled,ErpInvoiceStatus.Voided,ErpInvoiceStatus.Paid], [ErpInvoiceStatus.Cancelled]:[], [ErpInvoiceStatus.Voided]:[], [ErpInvoiceStatus.Paid]:[] };
function assertInvoiceTransition(current:string, target:string){ const allowed=INVOICE_STATUS_TRANSITIONS[current as ErpInvoiceStatus]??[]; if(!allowed.includes(target as ErpInvoiceStatus)) throw new BadRequestError("Invalid invoice status transition"); }
/** Sync terminal-method (.get/.all/.run) sibling of the query logic below — required inside db.transaction(), whose better-sqlite3 callback must be synchronous (no await). */
function nextInvoiceNumberSync(tx:any, year:number){ const row:any=tx.select({count:sql<number>`count(*)`}).from(invoices).where(like(invoices.invoiceNumber,`NOCT-${year}-%`)).get(); return `NOCT-${year}-${String(Number(row.count)+1).padStart(6,"0")}`; }
function withInvoiceLines(tx:any, row:any){ return { ...row, lines: tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId,row.id)).all() }; }
/**
 * The full write sequence (status/number/timestamps, invoice event, finance
 * entry) runs inside one synchronous db.transaction() so it commits or rolls
 * back atomically — see Sprint 45B. The outer function stays `async` (never
 * awaiting anything itself) purely so a synchronous throw from inside the
 * transaction still surfaces as a rejected Promise to existing callers/tests.
 */
/**
 * Sprint 79: invoice numbers are never caller-supplied — always the existing
 * yearly sequential allocator — and readiness (company/customer/line/VAT
 * completeness) is validated immediately before the atomic issue transaction,
 * outside it (a read-only check has nothing to roll back), so a rejected
 * issue attempt never partially mutates the invoice.
 */
export async function issueInvoice(db:DbClient,id:string,input:any={}){
  if(input.invoiceNumber) throw new BadRequestError("Invoice number cannot be manually supplied");
  const preRow:any=await getInvoice(db,id);
  if(preRow.status===ErpInvoiceStatus.Draft){ const readiness=await getInvoiceIssueReadiness(db,id); if(!readiness.ready) throw new BadRequestError(`Invoice is not ready to issue: ${readiness.issues.join("; ")}`); }
  for(let attempt=0; attempt<5; attempt++){ try { return db.transaction((tx) => { const row:any=tx.select().from(invoices).where(eq(invoices.id,id)).get(); if(!row) throw new NotFoundError("Invoice not found"); if(row.status===ErpInvoiceStatus.Issued) return withInvoiceLines(tx,row); assertInvoiceTransition(row.status,ErpInvoiceStatus.Issued); const year=new Date().getUTCFullYear(); const num=nextInvoiceNumberSync(tx,year); const t=input.issueAt??now(); tx.update(invoices).set({status:ErpInvoiceStatus.Issued,invoiceNumber:num,issuedAt:t,updatedAt:t}).where(and(eq(invoices.id,id),eq(invoices.status,ErpInvoiceStatus.Draft))).run(); tx.insert(invoiceEvents).values({id:randomUUID(),invoiceId:id,eventType:"Issued",previousStatus:ErpInvoiceStatus.Draft,newStatus:ErpInvoiceStatus.Issued,safeMetadata:JSON.stringify({invoiceNumber:num}),createdAt:t}).run(); createFinanceEntrySync(tx as unknown as DbClient,{invoiceId:id,orderId:row.orderId,entryType:"IssuedInvoice",amount:row.totalAmount,sourceReference:num,idempotencyKey:`invoice-issued:${id}`,occurredAt:t,snapshot:row}); const updated:any=tx.select().from(invoices).where(eq(invoices.id,id)).get(); return withInvoiceLines(tx,updated); }); } catch (error:any) { if(String(error?.message??error).includes("UNIQUE constraint failed")) continue; throw error; } } throw new ConflictError("Could not allocate a unique invoice number"); }
export async function setInvoiceStatus(db:DbClient,id:string,status:string){ return db.transaction((tx) => { const row:any=tx.select().from(invoices).where(eq(invoices.id,id)).get(); if(!row) throw new NotFoundError("Invoice not found"); const previousStatus=row.status; if(previousStatus===status) return withInvoiceLines(tx,row); assertInvoiceTransition(previousStatus,status); const t=now(); tx.update(invoices).set({status,cancelledAt:[ErpInvoiceStatus.Cancelled,ErpInvoiceStatus.Voided].includes(status as any)?t:row.cancelledAt,paidAt:status===ErpInvoiceStatus.Paid?t:row.paidAt,updatedAt:t}).where(eq(invoices.id,id)).run(); tx.insert(invoiceEvents).values({id:randomUUID(),invoiceId:id,eventType:status,previousStatus,newStatus:status,safeMetadata:JSON.stringify({}),createdAt:t}).run(); if(previousStatus===ErpInvoiceStatus.Issued && (status===ErpInvoiceStatus.Cancelled||status===ErpInvoiceStatus.Voided)){ const entryType=status===ErpInvoiceStatus.Cancelled?"InvoiceCancelled":"InvoiceVoided"; createFinanceEntrySync(tx as unknown as DbClient,{orderId:row.orderId,invoiceId:id,entryType,amount:-row.totalAmount,sourceReference:row.invoiceNumber,idempotencyKey:`invoice-${status.toLowerCase()}:${id}`,occurredAt:t,snapshot:row}); } const updated:any=tx.select().from(invoices).where(eq(invoices.id,id)).get(); return withInvoiceLines(tx,updated); }); }
async function invoiceEvent(db:DbClient,invoiceId:string,eventType:string,previousStatus:any,newStatus:any,safeMetadata:any){ await db.insert(invoiceEvents).values({id:randomUUID(),invoiceId,eventType,previousStatus,newStatus,safeMetadata:JSON.stringify(safeMetadata??{}),createdAt:now()}); }
export const getInvoiceEvents=(db:DbClient,id:string)=>db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId,id)).orderBy(desc(invoiceEvents.createdAt));
export { createFinanceEntry };
export async function listFinanceEntries(db:DbClient,q:any={}){ const f:any[]=[]; if(q.orderId)f.push(eq(financeEntries.orderId,String(q.orderId))); if(q.entryType)f.push(eq(financeEntries.entryType,String(q.entryType))); return {items:await db.select().from(financeEntries).where(f.length?and(...f):undefined).orderBy(desc(financeEntries.occurredAt)).limit(Number(q.pageSize??50)).offset((Number(q.page??1)-1)*Number(q.pageSize??50))}; }
export async function financeSummary(db:DbClient,q:any={}){ const sales=await db.select().from(saleFinancials); const refs=await db.select().from(refunds).where(eq(refunds.status,"succeeded")); const gross=money(sales.reduce((a,s)=>a+s.grossRevenue,0)), totalRefunds=money(refs.reduce((a,r)=>a+r.totalAmount,0)); const itemCost=money(sales.reduce((a,s)=>a+s.itemCost,0)); const feesKnown=sales.every(s=>s.marketplaceFee!=null&&s.paymentFee!=null); const fees=feesKnown?money(sales.reduce((a,s)=>a+(s.marketplaceFee??0)+(s.promotedFee??0)+(s.paymentFee??0),0)):null; const shippingCost=sales.every(s=>s.shippingCost!=null)?money(sales.reduce((a,s)=>a+s.shippingCost,0)):null; const profit=sales.length?money(sales.reduce((a,s)=>a+s.profit,0)):null; return {currency:"EUR",grossRevenue:gross,totalRefunds,netRevenue:money(gross-totalRefunds),itemCost,fees,shippingCost,profit,adjustedProfit:profit==null?null:money(profit-totalRefunds),completeness:feesKnown?"Complete":"Incomplete"}; }
export async function executeSalesCommand(db:DbClient,clientId:string,env:any,type:string,id?:string){
  const c=await command(db,clientId,env,type,type.includes("Invoice")?"Invoice":"Order",id);
  if(c.replay) return c.result;
  const p=env.payload??{};
  let out:any;
  try {
    if(type==="CreateInternalSale") out=await createInternalSale(db,p);
    else if(type==="CompleteSale") out=await completeSale(db,id!);
    else if(type==="CreateInvoice") out=await createInvoiceDraft(db,id!,p);
    else if(type==="UpdateInvoice") out=await updateInvoiceDraft(db,id!,p);
    else if(type==="UpdateInvoiceLine") out=await updateInvoiceLine(db,id!,p.lineId,p);
    else if(type==="SwitchInvoiceCalculationMode") out=await switchInvoiceCalculationMode(db,id!,p.calculationMode);
    else if(type==="RecalculateInvoice") out=await recalculateInvoiceDraft(db,id!);
    else if(type==="RefreshInvoiceSellerSnapshot") out=await refreshInvoiceSellerSnapshot(db,id!);
    else if(type==="IssueInvoice") out=await issueInvoice(db,id!,p);
    else if(type==="CancelInvoice") out=await setInvoiceStatus(db,id!,ErpInvoiceStatus.Cancelled);
    else if(type==="VoidInvoice") out=await setInvoiceStatus(db,id!,ErpInvoiceStatus.Voided);
    else if(type==="MarkInvoicePaid") out=await setInvoiceStatus(db,id!,ErpInvoiceStatus.Paid);
  } catch (error) {
    await failCommand(db,clientId,env.idempotencyKey,error);
    throw error;
  }
  await finish(db,clientId,env.idempotencyKey,"Completed",out.id??out.orderId??id,{type,entityId:out.id??out.orderId??id});
  return out;
}
export { getSaleCompletionReadiness };
export async function refundSummary(db:DbClient,orderId:string){ return {orderId,totalRefunded:(await adjustedFinancials(db,orderId)).totalRefunded,refunds:await db.select().from(refunds).where(eq(refunds.orderId,orderId))}; }
export async function reversalSummary(db:DbClient,orderId:string){ const reversals=await db.select().from(saleReversals).where(eq(saleReversals.orderId,orderId)); return {orderId,reversed:reversals.length>0,reversals}; }
