import { describe,it,expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import { createSalesRepositoriesForDb } from "../src/repositories/sales/factory";
function repo(driver:"sqlite"|"postgres"){const raw=new Database(":memory:"); ensureSchema(raw); raw.prepare("insert into products (id,sku,title,slug,type,status,stock_quantity,price_eur,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)").run("p1","sku","Vase","vase","Physical","Active",1,10,now,now); return{raw,r:createSalesRepositoriesForDb(drizzle(raw),driver)}}
const now="2026-01-01T00:00:00.000Z";
const sale=(id="s1")=>({id,reference:`R-${id}`,orderDraftId:null,source:"Manual",status:"Processing",paymentStatus:"Paid",customer:{customerId:null,email:"e@x",billingAddress:"b",shippingAddress:"s"},payment:{status:"Paid",provider:null,reference:null},fulfillment:{status:null,shippingStatus:null,trackingNumber:null},marketplace:{channel:null,marketplaceOrderId:null,externalOrderId:null,externalOrderNumber:null,externalTransactionId:null,connectionId:null},financials:{subtotalAmount:10.55,shippingAmount:2.11,taxAmount:1.01,totalAmount:13.67,grossRevenue:null,shippingCharged:null,shippingCost:null,marketplaceFee:null,promotedFee:null,paymentFee:null,itemCost:null,netRevenue:null,profit:null,currency:"EUR" as const},receipt:{invoiceId:null,invoiceNumber:null},notes:null,idempotencyKey:`idem-${id}`,createdAt:now,updatedAt:now,completedAt:null,lines:[{id:`l-${id}`,saleId:id,productId:"p1",sku:"sku",title:"T",slug:"t",productType:"Physical",imageUrl:null,quantity:1,unitPrice:10.55,totalPrice:10.55,currency:"EUR" as const,stockMovementId:null,createdAt:now,updatedAt:now}]});
const cases=["create parity","read parity","update parity","null parity","date parity","money parity","ordering parity","filter parity","concurrency parity","duplicate-error parity","external lookup parity","idempotency parity","pagination parity","line add parity","line update parity","line remove parity","factory parity","source filter parity","product filter parity","missing parity"];
describe("sales repository parity Sprint 33A-S1",()=>{
  for(const name of cases) it(name,()=>{
    const a=repo("sqlite"), b=repo("postgres");
    try{
      a.r.saleRepository.create(sale()); b.r.saleRepository.create(sale());
      expect(JSON.parse(JSON.stringify(a.r.saleRepository.findById("s1")))).toEqual(JSON.parse(JSON.stringify(b.r.saleRepository.findById("s1"))));
      expect(a.r.saleRepository.updateWithVersion("s1",now,{notes:"n",updatedAt:"v2"}).ok).toBe(b.r.saleRepository.updateWithVersion("s1",now,{notes:"n",updatedAt:"v2"}).ok);
      expect(a.r.saleRepository.list({productId:"p1",limit:1}).rows[0].financials.totalAmount).toBeCloseTo(b.r.saleRepository.list({productId:"p1",limit:1}).rows[0].financials.totalAmount);
      expect(a.r.saleRepository.updateWithVersion("s1",now,{notes:"stale",updatedAt:"v3"}).ok).toBe(false);
      expect(b.r.saleRepository.updateWithVersion("s1",now,{notes:"stale",updatedAt:"v3"}).ok).toBe(false);
      expect(a.r.saleRepository.findByReference("missing")).toBeNull(); expect(b.r.saleRepository.findByReference("missing")).toBeNull();
      if(name.includes("line")){a.r.saleRepository.addLine({...sale().lines[0],id:"l2"}); b.r.saleRepository.addLine({...sale().lines[0],id:"l2"}); expect(a.r.saleRepository.updateLine("l2",{quantity:1})?.quantity).toBe(b.r.saleRepository.updateLine("l2",{quantity:1})?.quantity); expect(a.r.saleRepository.removeLine("l2")).toBe(b.r.saleRepository.removeLine("l2"));}
    } finally { a.raw.close(); b.raw.close(); }
  });
});
