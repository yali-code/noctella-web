import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { CarrierCode, ErpInvoiceStatus, MarketplaceFulfillmentStatus, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType, RefundStatus, RefundType, ShipmentStatus } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { createRefund, reverseCompletedSale } from "../src/services/returns";
import { completeSale, getSaleCompletionReadiness } from "../src/services/shipments";
import { adjustedFinancials, createFinanceEntry, createInternalSale, createInvoiceDraft, executeSalesCommand, financeSummary, getInvoice, getInvoiceEvents, issueInvoice, listFinanceEntries, listInvoices, listSales, refundSummary, reversalSummary, saleProjection, setInvoiceStatus, updateInvoiceDraft } from "../src/services/erpSalesFinanceBridge";
import { BadRequestError, ConflictError } from "../src/services/errors";

type Db = ReturnType<typeof drizzle<typeof schema>>;
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
function memoryDb(){ const sqlite=new Database(":memory:"); sqlite.pragma("foreign_keys = ON"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite,{schema}) as any as Db }; }
async function seed(db:any, count=2){ const cat=await createCategory(db,{name:`Cat-${Math.random()}`,displayOrder:0,isActive:true}); const products=[]; for(let i=0;i<count;i++) products.push(await createProduct(db,{sku:`SKU-${Math.random()}-${i}`,title:`Product ${i}`,slug:`product-${Math.random()}-${i}`,type:ProductType.UniqueItem,status:ProductStatus.Published,categoryId:cat.id,customsWarning:false,isFeatured:false,allowMakeOffer:false,allowCashOnDelivery:false,showInArchiveAfterSale:false,priceEur:100+i*25,purchaseCost:40+i,stockQuantity:1,images:[]})); return products; }
async function paidOrder(db:any, products:any[]){ const ref=`pay-ref-${Math.random()}`; await createPaymentSession(db,{provider:PaymentProvider.Stripe,providerReference:ref,status:PaymentStatus.Paid,amount:products.reduce((a,p)=>a+p.priceEur,0),currency:"EUR",idempotencyKey:`test:${ref}`}); return createOrder(db,{orderDraftId:`draft-${Math.random()}`,guestEmail:"jane@example.com",status:OrderStatus.Processing,paymentStatus:PaymentStatus.Paid,paymentProvider:PaymentProvider.Stripe,paymentReference:ref,currency:PriceCurrency.Eur,billingAddress:address,shippingAddress:address,subtotalAmount:products.reduce((a,p)=>a+p.priceEur,0),totalAmount:products.reduce((a,p)=>a+p.priceEur,0),items:products.map(p=>({productId:p.id,quantity:1 as const}))}); }
async function shipment(db:any, orderId:string, status=ShipmentStatus.InTransit, marketplace=false, fulfillment=MarketplaceFulfillmentStatus.Accepted){ const id=`ship-${Math.random()}`; await db.insert(schema.shipments).values({id,orderId,marketplaceOrderId:marketplace?`mo-${id}`:null,channel:marketplace?"eBay":null,carrierCode:CarrierCode.LocalPickup,status,shippingCost:10,currency:"EUR",marketplaceFulfillmentStatus:marketplace?fulfillment:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); return id; }

describe("ERP sales finance bridge", () => {
  let sqlite: Database.Database; let db: any;
  beforeEach(()=>{ const m=memoryDb(); sqlite=m.sqlite; db=m.db; });

  it("keeps schema.ts, schema.sql and migrations consistent/idempotent", () => { ensureSchema(sqlite); const tables=sqlite.prepare("select name from sqlite_master where type='table'").all().map((r:any)=>r.name); for(const t of ["invoices","invoice_lines","invoice_events","finance_entries"]) expect(tables).toContain(t); const indexes=sqlite.prepare("select name from sqlite_master where type='index'").all().map((r:any)=>r.name); for(const idx of ["idx_invoices_erp_reference_unique","idx_invoices_number_unique","idx_finance_entries_idempotency_unique","idx_invoices_order","idx_invoices_customer","idx_invoices_status","idx_invoices_type","idx_invoices_dates"]) expect(indexes).toContain(idx); const upgraded=new Database(":memory:"); ensureSchema(upgraded); ensureSchema(upgraded); expect(upgraded.prepare("select name from sqlite_master where name='finance_entries'").get()).toBeTruthy(); });

  it("projects internal and marketplace sales with masking, null fees, refunds, reversals, filters and no secrets", async () => { const ps=await seed(db,2); const order=await paidOrder(db,ps); await db.insert(schema.marketplaceConnections).values({id:"conn-secret",channel:"eBay",accountLabel:"Safe",status:"connected",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await db.insert(schema.marketplaceOrders).values({id:"mo1",channel:"eBay",externalOrderId:"ext",marketplaceConnectionId:"conn-secret",internalOrderId:order.id,status:"paid",importStatus:"imported",currency:"EUR",subtotal:225,shipping:0,tax:0,total:225,rawPayloadSnapshot:JSON.stringify({access_token:"secret"}),orderedAt:new Date().toISOString(),importedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await createRefund(db,{orderId:order.id,channel:"eBay",type:RefundType.Partial,status:RefundStatus.Succeeded,currency:PriceCurrency.Eur,subtotalAmount:25,shippingAmount:0,taxAmount:0,reason:"test",idempotencyKey:"refund-1"}); const projection=await saleProjection(db,order.id); expect(projection.channel).toBe("eBay"); expect(projection.customer.email).toBeNull(); expect(projection.customer.maskedEmail).toContain("***"); expect(projection.financials.marketplaceFee).toBeNull(); expect(projection.financials.promotedFee).toBeNull(); expect(projection.financials.paymentFee).toBeNull(); expect(projection.financials.shippingCost).toBeNull(); expect(projection.financials.totalRefunded).toBe(25); expect(projection.financials.adjustedCompleteness).toBe("Incomplete"); expect(JSON.stringify(projection)).not.toMatch(/access_token|secret|conn-secret/); expect((await listSales(db,{page:1,pageSize:1,search:order.orderNumber})).items).toHaveLength(1); expect((await refundSummary(db,order.id)).totalRefunded).toBe(25); expect((await reversalSummary(db,order.id)).reversed).toBe(false); });

  it("creates safe Internal/Direct/LocalPickup/Other sales and rejects marketplace impersonation/non-EUR/invalid quantities/stock", async () => { const ps=await seed(db,2); for(const channel of ["Internal","Direct","LocalPickup","Other"]) { const p=(await seed(db,1))[0]; const sale=await createInternalSale(db,{channel,currency:"EUR",paymentStatus:PaymentStatus.Paid,subtotalAmount:p.priceEur,totalAmount:p.priceEur,lines:[{productId:p.id,quantity:1}]}); expect(sale.items).toHaveLength(1); } await expect(createInternalSale(db,{channel:"eBay",currency:"EUR",paymentStatus:PaymentStatus.Paid,lines:[{productId:ps[0].id,quantity:1}]})).rejects.toBeInstanceOf(BadRequestError); await expect(createInternalSale(db,{channel:"Etsy",currency:"EUR",paymentStatus:PaymentStatus.Paid,lines:[{productId:ps[0].id,quantity:1}]})).rejects.toBeInstanceOf(BadRequestError); await expect(createInternalSale(db,{channel:"Internal",currency:"USD",paymentStatus:PaymentStatus.Paid,lines:[{productId:ps[0].id,quantity:1}]})).rejects.toBeInstanceOf(BadRequestError); await expect(createInternalSale(db,{channel:"Internal",currency:"EUR",paymentStatus:PaymentStatus.Paid,subtotalAmount:100,totalAmount:100,lines:[{productId:ps[0].id,quantity:2}]})).rejects.toBeInstanceOf(BadRequestError); await createInternalSale(db,{channel:"Internal",currency:"EUR",paymentStatus:PaymentStatus.Paid,subtotalAmount:ps[0].priceEur,totalAmount:ps[0].priceEur,lines:[{productId:ps[0].id,quantity:1}]}); await expect(createInternalSale(db,{channel:"Internal",currency:"EUR",paymentStatus:PaymentStatus.Paid,subtotalAmount:ps[0].priceEur,totalAmount:ps[0].priceEur,lines:[{productId:ps[0].id,quantity:1}]})).rejects.toBeInstanceOf(BadRequestError); });

  it("idempotent internal sale creates one order, one sale movement, no invoice and no finance entry", async () => { const [p]=await seed(db,1); const env={idempotencyKey:"sale-key",payload:{channel:"Internal",currency:"EUR",paymentStatus:PaymentStatus.Paid,subtotalAmount:p.priceEur,totalAmount:p.priceEur,lines:[{productId:p.id,quantity:1}]}}; const a:any=await executeSalesCommand(db,"erp-client",env,"CreateInternalSale"); const b:any=await executeSalesCommand(db,"erp-client",env,"CreateInternalSale"); expect(b.status).toBe("Completed"); expect((await db.select().from(schema.orders))).toHaveLength(1); expect((await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.type,"sale")))).toHaveLength(1); expect((await listInvoices(db,{})).items).toHaveLength(0); expect((await listFinanceEntries(db,{})).items).toHaveLength(0); expect(a.id).toBeTruthy(); });

  it("blocks complete sale until paid, shipped, marketplace accepted, and cost data exists", async () => { const [p]=await seed(db,1); await createPaymentSession(db,{provider:PaymentProvider.Stripe,providerReference:"pay",status:PaymentStatus.Paid,amount:p.priceEur,currency:"EUR",idempotencyKey:"test:pay"}); const unpaid=await createOrder(db,{orderDraftId:"unpaid",guestEmail:"jane@example.com",status:OrderStatus.Processing,paymentStatus:PaymentStatus.Paid,paymentProvider:PaymentProvider.Stripe,paymentReference:"pay",currency:PriceCurrency.Eur,billingAddress:address,shippingAddress:address,subtotalAmount:p.priceEur,totalAmount:p.priceEur,items:[{productId:p.id,quantity:1 as const}]}); await db.update(schema.orders).set({paymentStatus:PaymentStatus.Pending}).where(eq(schema.orders.id,unpaid.id)); expect((await getSaleCompletionReadiness(db,unpaid.id)).issues).toContain("Order is unpaid"); await db.update(schema.orders).set({paymentStatus:PaymentStatus.Paid}).where(eq(schema.orders.id,unpaid.id)); expect((await getSaleCompletionReadiness(db,unpaid.id)).issues.join(" ")).toContain("Shipment"); await shipment(db,unpaid.id,ShipmentStatus.InTransit,true,MarketplaceFulfillmentStatus.Pending); expect((await getSaleCompletionReadiness(db,unpaid.id)).issues.join(" ")).toContain("Marketplace fulfillment"); });

  it("completes sale once, posts one financial record/entry, does not move stock again, and preserves sale movements", async () => { const [p]=await seed(db,1); const order=await paidOrder(db,[p]); await shipment(db,order.id); const beforeStock=(await db.select().from(schema.products).where(eq(schema.products.id,p.id)))[0].stockQuantity; const beforeMoves=(await db.select().from(schema.stockMovements)).length; const first=await completeSale(db,order.id); const second=await completeSale(db,order.id); expect(first.status).toBe(OrderStatus.Completed); expect(second.alreadyCompleted).toBe(true); expect((await db.select().from(schema.products).where(eq(schema.products.id,p.id)))[0].stockQuantity).toBe(beforeStock); expect((await db.select().from(schema.stockMovements))).toHaveLength(beforeMoves); expect((await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId,order.id)))).toHaveLength(1); expect((await listFinanceEntries(db,{entryType:"CompleteSale"})).items).toHaveLength(1); });

  it("creates, updates, issues, cancels, voids and marks paid invoices without stock/payment/PDF/email side effects", async () => { const [p]=await seed(db,1); const order=await paidOrder(db,[p]); const stock=(await db.select().from(schema.products).where(eq(schema.products.id,p.id)))[0].stockQuantity; const moves=(await db.select().from(schema.stockMovements)).length; const draft:any=await createInvoiceDraft(db,order.id,{erpReferenceId:"erp-inv",notes:"draft"}); expect(draft.status).toBe(ErpInvoiceStatus.Draft); expect(draft.lines[0].lineTotal).toBe(draft.subtotal); const updated:any=await updateInvoiceDraft(db,draft.id,{expectedUpdatedAt:draft.updatedAt,notes:"updated"}); expect(updated.notes).toBe("updated"); await expect(updateInvoiceDraft(db,draft.id,{expectedUpdatedAt:"stale"})).rejects.toBeInstanceOf(ConflictError); await expect(createInvoiceDraft(db,order.id,{discountAmount:-1})).rejects.toBeInstanceOf(BadRequestError); const issued:any=await issueInvoice(db,draft.id,{}); expect(issued.invoiceNumber).toMatch(/^NOCT-\d{4}-000001$/); await expect(updateInvoiceDraft(db,draft.id,{expectedUpdatedAt:issued.updatedAt,notes:"bad"})).rejects.toBeInstanceOf(ConflictError); expect((await issueInvoice(db,draft.id,{})).invoiceNumber).toBe(issued.invoiceNumber); expect((await setInvoiceStatus(db,draft.id,ErpInvoiceStatus.Cancelled)).invoiceNumber).toBe(issued.invoiceNumber);
    const voidDraft:any=await createInvoiceDraft(db,order.id,{erpReferenceId:"erp-inv-void"}); const voided:any=await issueInvoice(db,voidDraft.id,{}); expect((await setInvoiceStatus(db,voided.id,ErpInvoiceStatus.Voided)).status).toBe(ErpInvoiceStatus.Voided);
    const paidDraft:any=await createInvoiceDraft(db,order.id,{erpReferenceId:"erp-inv-paid"}); const paidSource:any=await issueInvoice(db,paidDraft.id,{}); expect((await setInvoiceStatus(db,paidSource.id,ErpInvoiceStatus.Paid)).paidAt).toBeTruthy();
    expect(await getInvoiceEvents(db,draft.id)).not.toHaveLength(0); expect((await db.select().from(schema.products).where(eq(schema.products.id,p.id)))[0].stockQuantity).toBe(stock); expect((await db.select().from(schema.stockMovements))).toHaveLength(moves); expect(JSON.stringify(await getInvoiceEvents(db,draft.id))).not.toMatch(/pdfReady|emailReady|payment_intent/i); });

  it("allocates unique sequential invoice numbers under concurrent issue attempts and prevents duplicate invoice finance entries", async () => { const ps=await seed(db,2); const order=await paidOrder(db,ps); const d1:any=await createInvoiceDraft(db,order.id,{}); const d2:any=await createInvoiceDraft(db,order.id,{erpReferenceId:"second"}); const [i1,i2]:any[]=await Promise.all([issueInvoice(db,d1.id,{}), issueInvoice(db,d2.id,{})]); expect(new Set([i1.invoiceNumber,i2.invoiceNumber]).size).toBe(2); await createFinanceEntry(db,{invoiceId:i1.id,orderId:order.id,entryType:"IssuedInvoice",amount:i1.totalAmount,sourceReference:i1.invoiceNumber,idempotencyKey:`invoice-issued:${i1.id}`}); expect((await listFinanceEntries(db,{entryType:"IssuedInvoice"})).items).toHaveLength(2); });

  it("wires refund and reversal finance events idempotently and preserves original sale financials", async () => { const [p]=await seed(db,1); const order=await paidOrder(db,[p]); await shipment(db,order.id); await completeSale(db,order.id); const original=(await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId,order.id)))[0]; await createRefund(db,{orderId:order.id,channel:"Internal",type:RefundType.Full,status:RefundStatus.Succeeded,currency:PriceCurrency.Eur,subtotalAmount:order.totalAmount,shippingAmount:0,taxAmount:0,reason:"full",idempotencyKey:"refund-full"}); await db.insert(schema.returnRequests).values({id:"ret1",orderId:order.id,status:"completed",reason:"Return",requestedResolution:"Refund",requestedAt:new Date().toISOString(),completedAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); await db.insert(schema.returnItems).values({id:"ri1",returnRequestId:"ret1",orderItemId:order.items[0].id,productId:p.id,quantityRequested:1,quantityApproved:1,quantityReceived:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); const reversal:any=await reverseCompletedSale(db,{orderId:order.id,returnRequestId:"ret1",refundId:(await db.select().from(schema.refunds))[0].id}); expect((await listFinanceEntries(db,{entryType:"SuccessfulRefund"})).items).toHaveLength(1); expect((await listFinanceEntries(db,{entryType:"SaleReversal"})).items).toHaveLength(1); await createFinanceEntry(db,{orderId:order.id,saleReversalId:reversal.id,entryType:"SaleReversal",amount:0,sourceReference:reversal.id,idempotencyKey:`sale-reversal:${reversal.id}`}); expect((await listFinanceEntries(db,{entryType:"SaleReversal"})).items).toHaveLength(1); expect((await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId,order.id)))[0]).toMatchObject({id:original.id,profit:original.profit}); });

  it("summarizes finance with rounding, filters, nullable unknown fees and no free-form posting route", async () => { await createFinanceEntry(db,{orderId:"o1",entryType:"IssuedInvoice",amount:10.005,sourceReference:"I",idempotencyKey:"round"}); expect((await listFinanceEntries(db,{entryType:"IssuedInvoice"})).items[0].amount).toBe(10.01); const summary=await financeSummary(db,{}); expect(summary.currency).toBe("EUR"); expect(summary.fees).toBe(0); const routes=require("fs").readFileSync(require("path").join(__dirname,"../src/routes/erp.ts"),"utf8"); expect(routes).not.toContain("commands/finance"); });

  describe("finance ledger integrity on invoice cancel/void", () => {
    async function issuedInvoice() { const [p]=await seed(db,1); const order=await paidOrder(db,[p]); const draft:any=await createInvoiceDraft(db,order.id,{}); const issued:any=await issueInvoice(db,draft.id,{}); return { order, issued }; }

    it("Issued -> Cancelled posts exactly one InvoiceCancelled entry for the negative invoice total, leaving the original IssuedInvoice entry unchanged", async () => {
      const { issued } = await issuedInvoice();
      const originalBefore = (await listFinanceEntries(db,{entryType:"IssuedInvoice"})).items.find((e:any)=>e.invoiceId===issued.id);
      await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled);
      const cancelledEntries = (await listFinanceEntries(db,{entryType:"InvoiceCancelled"})).items.filter((e:any)=>e.invoiceId===issued.id);
      expect(cancelledEntries).toHaveLength(1);
      expect(cancelledEntries[0].amount).toBe(-issued.totalAmount);
      const originalAfter = (await listFinanceEntries(db,{entryType:"IssuedInvoice"})).items.find((e:any)=>e.invoiceId===issued.id);
      expect(originalAfter).toEqual(originalBefore);
    });

    it("Issued -> Voided posts exactly one InvoiceVoided entry for the negative invoice total", async () => {
      const { issued } = await issuedInvoice();
      await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Voided);
      const voidedEntries = (await listFinanceEntries(db,{entryType:"InvoiceVoided"})).items.filter((e:any)=>e.invoiceId===issued.id);
      expect(voidedEntries).toHaveLength(1);
      expect(voidedEntries[0].amount).toBe(-issued.totalAmount);
    });

    it("Draft -> Cancelled posts no reversal entry", async () => {
      const [p]=await seed(db,1); const order=await paidOrder(db,[p]); const draft:any=await createInvoiceDraft(db,order.id,{});
      await setInvoiceStatus(db,draft.id,ErpInvoiceStatus.Cancelled);
      expect((await listFinanceEntries(db,{entryType:"InvoiceCancelled"})).items.filter((e:any)=>e.invoiceId===draft.id)).toHaveLength(0);
    });

    it("Draft -> Voided is not a valid transition and posts no reversal entry", async () => {
      const [p]=await seed(db,1); const order=await paidOrder(db,[p]); const draft:any=await createInvoiceDraft(db,order.id,{});
      await expect(setInvoiceStatus(db,draft.id,ErpInvoiceStatus.Voided)).rejects.toBeInstanceOf(BadRequestError);
      expect((await listFinanceEntries(db,{entryType:"InvoiceVoided"})).items.filter((e:any)=>e.invoiceId===draft.id)).toHaveLength(0);
    });

    it("Mark Paid creates no finance entry", async () => {
      const { issued } = await issuedInvoice();
      await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Paid);
      const entries = (await listFinanceEntries(db,{})).items.filter((e:any)=>e.invoiceId===issued.id);
      expect(entries.filter((e:any)=>e.entryType!=="IssuedInvoice")).toHaveLength(0);
    });

    it("Cancelled and Voided are terminal — further transitions are rejected and never create another reversal", async () => {
      const { issued } = await issuedInvoice();
      await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled);
      await expect(setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Voided)).rejects.toBeInstanceOf(BadRequestError);
      await expect(setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Paid)).rejects.toBeInstanceOf(BadRequestError);
      const entries = (await listFinanceEntries(db,{})).items.filter((e:any)=>e.invoiceId===issued.id);
      expect(entries.filter((e:any)=>e.entryType==="InvoiceCancelled")).toHaveLength(1);
      expect(entries.filter((e:any)=>e.entryType==="InvoiceVoided")).toHaveLength(0);
    });

    it("repeated Cancel with the same outer command idempotency key creates no duplicate reversal", async () => {
      const { issued } = await issuedInvoice();
      const env = { idempotencyKey: "cancel-key-1", payload: {} };
      await executeSalesCommand(db,"erp-client",env,"CancelInvoice",issued.id);
      await executeSalesCommand(db,"erp-client",env,"CancelInvoice",issued.id);
      expect((await listFinanceEntries(db,{entryType:"InvoiceCancelled"})).items.filter((e:any)=>e.invoiceId===issued.id)).toHaveLength(1);
    });

    it("repeated Cancel with a different outer command idempotency key still creates no duplicate reversal", async () => {
      const { issued } = await issuedInvoice();
      await executeSalesCommand(db,"erp-client",{ idempotencyKey: "cancel-key-a", payload: {} },"CancelInvoice",issued.id);
      await executeSalesCommand(db,"erp-client",{ idempotencyKey: "cancel-key-b", payload: {} },"CancelInvoice",issued.id);
      expect((await listFinanceEntries(db,{entryType:"InvoiceCancelled"})).items.filter((e:any)=>e.invoiceId===issued.id)).toHaveLength(1);
    });

    it("repeated Void (different outer command idempotency keys) creates no duplicate reversal", async () => {
      const { issued } = await issuedInvoice();
      await executeSalesCommand(db,"erp-client",{ idempotencyKey: "void-key-a", payload: {} },"VoidInvoice",issued.id);
      await executeSalesCommand(db,"erp-client",{ idempotencyKey: "void-key-b", payload: {} },"VoidInvoice",issued.id);
      expect((await listFinanceEntries(db,{entryType:"InvoiceVoided"})).items.filter((e:any)=>e.invoiceId===issued.id)).toHaveLength(1);
    });
  });

  describe("invoice status transition validation", () => {
    async function draftInvoice() { const [p]=await seed(db,1); const order=await paidOrder(db,[p]); return createInvoiceDraft(db,order.id,{}); }
    async function issuedInvoice() { const draft:any=await draftInvoice(); return issueInvoice(db,draft.id,{}); }

    it("allows every valid edge: Draft->Cancelled, Issued->Cancelled, Issued->Voided, Issued->Paid, Draft->Issued", async () => {
      const d1:any=await draftInvoice(); expect((await setInvoiceStatus(db,d1.id,ErpInvoiceStatus.Cancelled)).status).toBe(ErpInvoiceStatus.Cancelled);
      const i1:any=await issuedInvoice(); expect((await setInvoiceStatus(db,i1.id,ErpInvoiceStatus.Cancelled)).status).toBe(ErpInvoiceStatus.Cancelled);
      const i2:any=await issuedInvoice(); expect((await setInvoiceStatus(db,i2.id,ErpInvoiceStatus.Voided)).status).toBe(ErpInvoiceStatus.Voided);
      const i3:any=await issuedInvoice(); expect((await setInvoiceStatus(db,i3.id,ErpInvoiceStatus.Paid)).status).toBe(ErpInvoiceStatus.Paid);
      const d2:any=await draftInvoice(); expect((await issueInvoice(db,d2.id,{})).status).toBe(ErpInvoiceStatus.Issued);
    });

    it("rejects every forbidden edge with BadRequestError", async () => {
      const cancelled:any=await issuedInvoice(); await setInvoiceStatus(db,cancelled.id,ErpInvoiceStatus.Cancelled);
      await expect(setInvoiceStatus(db,cancelled.id,ErpInvoiceStatus.Paid)).rejects.toBeInstanceOf(BadRequestError);
      await expect(setInvoiceStatus(db,cancelled.id,ErpInvoiceStatus.Voided)).rejects.toBeInstanceOf(BadRequestError);
      await expect(issueInvoice(db,cancelled.id,{})).rejects.toBeInstanceOf(BadRequestError);

      const voided:any=await issuedInvoice(); await setInvoiceStatus(db,voided.id,ErpInvoiceStatus.Voided);
      await expect(setInvoiceStatus(db,voided.id,ErpInvoiceStatus.Paid)).rejects.toBeInstanceOf(BadRequestError);
      await expect(setInvoiceStatus(db,voided.id,ErpInvoiceStatus.Cancelled)).rejects.toBeInstanceOf(BadRequestError);
      await expect(issueInvoice(db,voided.id,{})).rejects.toBeInstanceOf(BadRequestError);

      const paid:any=await issuedInvoice(); await setInvoiceStatus(db,paid.id,ErpInvoiceStatus.Paid);
      await expect(setInvoiceStatus(db,paid.id,ErpInvoiceStatus.Cancelled)).rejects.toBeInstanceOf(BadRequestError);
      await expect(setInvoiceStatus(db,paid.id,ErpInvoiceStatus.Voided)).rejects.toBeInstanceOf(BadRequestError);
      await expect(issueInvoice(db,paid.id,{})).rejects.toBeInstanceOf(BadRequestError);

      const draft:any=await draftInvoice();
      await expect(setInvoiceStatus(db,draft.id,ErpInvoiceStatus.Voided)).rejects.toBeInstanceOf(BadRequestError);
      await expect(setInvoiceStatus(db,draft.id,ErpInvoiceStatus.Paid)).rejects.toBeInstanceOf(BadRequestError);
    });

    it("same-status calls are idempotent no-ops: no status write, no new event, no new finance entry", async () => {
      const issued:any=await issuedInvoice();
      const eventsBeforeReissue=await getInvoiceEvents(db,issued.id);
      const reIssued:any=await issueInvoice(db,issued.id,{});
      expect(reIssued).toEqual(issued);
      expect(await getInvoiceEvents(db,issued.id)).toEqual(eventsBeforeReissue);

      const cancelled:any=await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled);
      const eventsAfterCancel=await getInvoiceEvents(db,issued.id);
      const reCancelled:any=await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled);
      expect(reCancelled).toEqual(cancelled);
      expect(await getInvoiceEvents(db,issued.id)).toEqual(eventsAfterCancel);
      expect((await listFinanceEntries(db,{entryType:"InvoiceCancelled"})).items.filter((e:any)=>e.invoiceId===issued.id)).toHaveLength(1);
    });

    it("standardizes IssueInvoice: only Draft->Issued is valid, Issued->Issued no-ops, every other source throws", async () => {
      const draft:any=await draftInvoice();
      const issued:any=await issueInvoice(db,draft.id,{});
      expect(issued.status).toBe(ErpInvoiceStatus.Issued);
      expect((await issueInvoice(db,draft.id,{})).invoiceNumber).toBe(issued.invoiceNumber);
      const cancelled:any=await setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled);
      await expect(issueInvoice(db,cancelled.id,{})).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe("transaction atomicity: rollback on partial failure (Sprint 45B)", () => {
    async function draftInvoiceHelper() { const [p]=await seed(db,1); const order=await paidOrder(db,[p]); return createInvoiceDraft(db,order.id,{}); }
    async function issuedInvoiceHelper() { const draft:any=await draftInvoiceHelper(); return issueInvoice(db,draft.id,{}); }
    function disableTable(name:string) { sqlite.exec(`ALTER TABLE ${name} RENAME TO ${name}_disabled`); }
    function restoreTable(name:string) { sqlite.exec(`ALTER TABLE ${name}_disabled RENAME TO ${name}`); }

    it("A: issueInvoice rolls back the invoice update if the event insert fails", async () => {
      const draft:any = await draftInvoiceHelper();
      const eventsBefore = await getInvoiceEvents(db,draft.id);
      disableTable("invoice_events");
      try {
        await expect(issueInvoice(db,draft.id,{})).rejects.toThrow();
      } finally {
        restoreTable("invoice_events");
      }
      const after:any = await getInvoice(db,draft.id);
      expect(after.status).toBe(ErpInvoiceStatus.Draft);
      expect(after.invoiceNumber).toBeNull();
      expect(after.issuedAt).toBeNull();
      expect(await getInvoiceEvents(db,draft.id)).toEqual(eventsBefore);
      expect((await listFinanceEntries(db,{entryType:"IssuedInvoice"})).items.filter((e:any)=>e.invoiceId===draft.id)).toHaveLength(0);
    });

    it("B: issueInvoice rolls back the invoice update and event if the finance entry insert fails", async () => {
      const draft:any = await draftInvoiceHelper();
      const eventsBefore = await getInvoiceEvents(db,draft.id);
      disableTable("finance_entries");
      try {
        await expect(issueInvoice(db,draft.id,{})).rejects.toThrow();
      } finally {
        restoreTable("finance_entries");
      }
      const after:any = await getInvoice(db,draft.id);
      expect(after.status).toBe(ErpInvoiceStatus.Draft);
      expect(after.invoiceNumber).toBeNull();
      expect(await getInvoiceEvents(db,draft.id)).toEqual(eventsBefore);
      expect((await listFinanceEntries(db,{entryType:"IssuedInvoice"})).items.filter((e:any)=>e.invoiceId===draft.id)).toHaveLength(0);
    });

    it("C: setInvoiceStatus rolls back the status update if the event insert fails", async () => {
      const issued:any = await issuedInvoiceHelper();
      const eventsBefore = await getInvoiceEvents(db,issued.id);
      disableTable("invoice_events");
      try {
        await expect(setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled)).rejects.toThrow();
      } finally {
        restoreTable("invoice_events");
      }
      const after:any = await getInvoice(db,issued.id);
      expect(after.status).toBe(ErpInvoiceStatus.Issued);
      expect(after.cancelledAt).toBeNull();
      expect(after.updatedAt).toBe(issued.updatedAt);
      expect(await getInvoiceEvents(db,issued.id)).toEqual(eventsBefore);
      expect((await listFinanceEntries(db,{entryType:"InvoiceCancelled"})).items.filter((e:any)=>e.invoiceId===issued.id)).toHaveLength(0);
    });

    it("D: setInvoiceStatus rolls back the status update and event if the reversal entry insert fails", async () => {
      const issued:any = await issuedInvoiceHelper();
      const eventsBefore = await getInvoiceEvents(db,issued.id);
      disableTable("finance_entries");
      try {
        await expect(setInvoiceStatus(db,issued.id,ErpInvoiceStatus.Cancelled)).rejects.toThrow();
      } finally {
        restoreTable("finance_entries");
      }
      const after:any = await getInvoice(db,issued.id);
      expect(after.status).toBe(ErpInvoiceStatus.Issued);
      expect(after.cancelledAt).toBeNull();
      expect(await getInvoiceEvents(db,issued.id)).toEqual(eventsBefore);
    });
  });

  it("has all requested ERP routes and safe command audit metadata without raw customer/invoice payloads", async () => { const routes=require("fs").readFileSync(require("path").join(__dirname,"../src/routes/erp.ts"),"utf8"); for(const fragment of ["/sales","/sales/:id","/orders/:id/sales-summary","/orders/:id/financials","/orders/:id/refund-summary","/orders/:id/reversal-summary","/commands/sales/create","/commands/orders/:orderId/complete-sale","/orders/:orderId/complete-sale/readiness","/customers","/customers/:id","/orders/:orderId/customer","/commands/orders/:orderId/invoices/create","/commands/invoices/:invoiceId/update","/commands/invoices/:invoiceId/issue","/commands/invoices/:invoiceId/cancel","/commands/invoices/:invoiceId/mark-paid","/invoices","/invoices/:id","/orders/:orderId/invoices","/invoices/:id/events","/finance/entries","/finance/summary","/finance/orders/:orderId"]) expect(routes).toContain(fragment); const [p]=await seed(db,1); const env={idempotencyKey:"audit",payload:{channel:"Internal",currency:"EUR",paymentStatus:PaymentStatus.Paid,customer:{email:"raw@example.com",address},subtotalAmount:p.priceEur,totalAmount:p.priceEur,lines:[{productId:p.id,quantity:1}]}}; await executeSalesCommand(db,"client",env,"CreateInternalSale"); const audit=(await db.select().from(schema.erpCommandExecutions))[0]; expect(audit.safeResultMetadata).not.toContain("raw@example.com"); expect(audit.safeResultMetadata).not.toContain("line1"); });
});
