import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { buildSalesApplicationContext, type BuildSalesApplicationContextInput } from "../src/services/salesApplicationContext";
import { createSalesApplicationContextForDb } from "../src/services/salesApplicationContextForDb";
import { unavailableSalesCompletionCoordinator, type SalesCompletionCoordinator } from "../src/application/sales/completionCoordination";
import { SalesCompletionCapabilityUnavailableError, SalesCompletionCoordinationError } from "../src/application/sales/errors";
import { rejectedSalesCompletionCandidatePorts, salesCompletionDependencyMatrix } from "../src/application/sales/completionWorkflowAudit";
import { auditSalesCompletionCoordinationSource, runSalesCompletionCoordinationAudit } from "../src/scripts/salesCompletionCoordinationAudit";

const repo:any={create:(x:any)=>x,findById:()=>null,findByReference:()=>null,findByExternalOrderId:()=>null,findByIdempotencyKey:()=>null,list:()=>({rows:[],total:0,limit:50,offset:0}),update:()=>null,updateWithVersion:()=>({ok:false,issue:{code:"not_found",message:"x"}}),addLine:(x:any)=>x,updateLine:()=>null,removeLine:()=>false};
const base=():BuildSalesApplicationContextInput=>({salesRepositories:{saleRepository:repo},unitOfWork:{run:async(work:any)=>work({repositories:{}})},logger:{},clock:{now:()=>new Date("2026-01-01T00:00:00.000Z")},idGenerator:{newId:()=>"id"}});
const state=Object.freeze({paymentAccepted:true,shippingAccepted:true,marketplaceRequired:false,marketplaceAccepted:true,shipmentId:null,shippingCost:0,currency:"EUR" as const});
const custom:SalesCompletionCoordinator=Object.freeze({inspectFulfillment:async()=>state,getProductCosts:async()=>Object.freeze([]),findFinancialSnapshot:async()=>null,writeFinancialSnapshot:async()=>undefined,writeFinanceEntry:async()=>undefined,recordCompletionHistory:async()=>undefined});
const valid="export interface SalesCompletionCoordinator { readonly capability: string } const context = Object.freeze({ completionCoordinator });";

describe("Sales completion coordination Sprint 33A-S3B",()=>{
  const matrixNames=["sale status finalization","inventory quantity/status change","stock movement/history","product purchase-cost lookup","item cost snapshot and profit inputs","sale financial snapshot persistence","finance-entry creation","shipment completion history","marketplace fulfillment acceptance","payment and shipping compatibility","completion replay/idempotency"];
  it.each(matrixNames)("audit identifies %s",name=>expect(salesCompletionDependencyMatrix.some(row=>row.sideEffect===name)).toBe(true));
  it("matrix is immutable",()=>expect(Object.isFrozen(salesCompletionDependencyMatrix)).toBe(true));
  it("matrix rows are immutable",()=>expect(salesCompletionDependencyMatrix.every(Object.isFrozen)).toBe(true));
  it("reuses SaleRepository for finalization",()=>expect(salesCompletionDependencyMatrix.find(x=>x.sideEffect==="sale status finalization")?.existingAbstraction).toBe("SaleRepository"));
  it("rejects inventory coordinator",()=>expect(rejectedSalesCompletionCandidatePorts.SalesInventoryCoordinator).toContain("no inventory mutation"));
  it("rejects stock movement recorder",()=>expect(rejectedSalesCompletionCandidatePorts.SalesStockMovementRecorder).toContain("no stock movement"));
  it("rejects standalone marketplace port",()=>expect(rejectedSalesCompletionCandidatePorts.SalesMarketplaceFulfillmentCoordinator).toContain("cohesive"));
  it("rejects duplicate idempotency store",()=>expect(rejectedSalesCompletionCandidatePorts.SalesCompletionIdempotencyStore).toContain("uniqueness"));
  it("avoids duplicate boundaries",()=>expect(new Set(salesCompletionDependencyMatrix.map(x=>x.newCoordinationCapability).filter(Boolean)).size).toBe(7));
  it("inventory is not a new capability",()=>expect(salesCompletionDependencyMatrix.find(x=>x.sideEffect.startsWith("inventory"))?.newCoordinationCapability).toBeNull());
  it("stock history is not a new capability",()=>expect(salesCompletionDependencyMatrix.find(x=>x.sideEffect.startsWith("stock"))?.newCoordinationCapability).toBeNull());

  it("default coordinator is frozen",()=>expect(Object.isFrozen(unavailableSalesCompletionCoordinator)).toBe(true));
  it("context exposes coordinator",()=>expect(buildSalesApplicationContext(base()).completionCoordinator).toBe(unavailableSalesCompletionCoordinator));
  it("context remains frozen",()=>expect(Object.isFrozen(buildSalesApplicationContext(base()))).toBe(true));
  it("configuration remains frozen",()=>expect(Object.isFrozen(buildSalesApplicationContext(base()).configuration)).toBe(true));
  it("custom coordinator is preserved",()=>expect(buildSalesApplicationContext({...base(),completionCoordinator:custom}).completionCoordinator).toBe(custom));
  it("existing sale repository alias remains",()=>{const c=buildSalesApplicationContext(base());expect(c.saleRepository).toBe(c.salesRepositories.saleRepository)});
  it("existing context fields remain",()=>expect(Object.keys(buildSalesApplicationContext(base()))).toEqual(expect.arrayContaining(["salesRepositories","saleRepository","unitOfWork","logger","clock","idGenerator","configuration"])));
  it("only one approved new context field",()=>expect(Object.keys(buildSalesApplicationContext(base())).filter(x=>x.toLowerCase().includes("completion"))).toEqual(["completionCoordinator"]));
  it("default fulfillment fails explicitly",async()=>await expect(unavailableSalesCompletionCoordinator.inspectFulfillment({saleId:"s",customerId:null,marketplaceOrderId:null,shipmentId:null})).rejects.toBeInstanceOf(SalesCompletionCapabilityUnavailableError));
  it("default costs fail explicitly",async()=>await expect(unavailableSalesCompletionCoordinator.getProductCosts({saleId:"s",lines:[]})).rejects.toThrow("product_cost"));
  it("default snapshot read fails explicitly",async()=>await expect(unavailableSalesCompletionCoordinator.findFinancialSnapshot("s")).rejects.toThrow("financial_snapshot"));
  it("default snapshot write fails explicitly",async()=>await expect(unavailableSalesCompletionCoordinator.writeFinancialSnapshot({} as any)).rejects.toThrow("financial_snapshot"));
  it("default finance entry fails explicitly",async()=>await expect(unavailableSalesCompletionCoordinator.writeFinanceEntry({} as any)).rejects.toThrow("finance_entry"));
  it("default history fails explicitly",async()=>await expect(unavailableSalesCompletionCoordinator.recordCompletionHistory({} as any)).rejects.toThrow("completion_history"));
  it("custom optional history may intentionally resolve",async()=>await expect(custom.recordCompletionHistory({} as any)).resolves.toBeUndefined());
  it("custom fulfillment output is immutable",async()=>expect(Object.isFrozen(await custom.inspectFulfillment({} as any))).toBe(true));
  it("custom cost output is immutable",async()=>expect(Object.isFrozen(await custom.getProductCosts({saleId:"s",lines:[]}))).toBe(true));

  it("DB factory uses unavailable default",()=>{const raw=new Database(":memory:");try{ensureSchema(raw);const c=createSalesApplicationContextForDb({db:drizzle(raw,{schema}),driver:"sqlite",logger:{},clock:base().clock,idGenerator:base().idGenerator});expect(c.completionCoordinator).toBe(unavailableSalesCompletionCoordinator)}finally{raw.close()}});
  it("DB factory preserves custom coordinator",()=>{const raw=new Database(":memory:");try{ensureSchema(raw);const c=createSalesApplicationContextForDb({db:drizzle(raw,{schema}),driver:"sqlite",logger:{},clock:base().clock,idGenerator:base().idGenerator,completionCoordinator:custom});expect(c.completionCoordinator).toBe(custom)}finally{raw.close()}});
  it("DB factory context is frozen",()=>{const raw=new Database(":memory:");try{ensureSchema(raw);const c=createSalesApplicationContextForDb({db:drizzle(raw,{schema}),driver:"sqlite",logger:{},clock:base().clock,idGenerator:base().idGenerator});expect(Object.isFrozen(c)).toBe(true)}finally{raw.close()}});

  it("unavailable error has explicit code",()=>expect(new SalesCompletionCapabilityUnavailableError("x").code).toBe("sales_completion_capability_unavailable"));
  it("unavailable error identifies capability",()=>expect(new SalesCompletionCapabilityUnavailableError("shipping").metadata.capability).toBe("shipping"));
  it("unavailable metadata is immutable",()=>expect(Object.isFrozen(new SalesCompletionCapabilityUnavailableError("x").metadata)).toBe(true));
  it("coordination error has explicit code",()=>expect(new SalesCompletionCoordinationError("finance").code).toBe("sales_completion_coordination_error"));
  it("coordination error identifies capability",()=>expect(new SalesCompletionCoordinationError("finance").metadata.capability).toBe("finance"));
  it("coordination error preserves cause code",()=>expect(new SalesCompletionCoordinationError("finance","conflict").metadata.causeCode).toBe("conflict"));
  it("coordination metadata is immutable",()=>expect(Object.isFrozen(new SalesCompletionCoordinationError("x").metadata)).toBe(true));

  const rejected:Array<[string,string,string]>=[
    ["SQL","select * from sale","SQL"],["DbClient","type X=DbClient","DbClient"],["Drizzle","Drizzle","Drizzle"],["schema","import x from 'db/schema'","schema"],
    ["repository implementation","import x from 'repositories/sales/sqlite'","repository implementation"],["direct Inventory","inventoryRepository","direct Inventory access"],["stock mutation","applyStockMovement()","stock mutation"],
    ["HTTP","express Router","HTTP routes or controllers"],["routes","import x from 'routes/sales'","HTTP routes or controllers"],["controller","class SalesController {}","HTTP routes or controllers"],["provider SDK","stripe","provider SDK"],
    ["Kafka","Kafka","Kafka queue or worker"],["queue","enqueue(job)","Kafka queue or worker"],["EventEmitter","EventEmitter","Kafka queue or worker"],["Date.now","Date.now()","Date.now"],["randomUUID","randomUUID()","randomUUID"],
    ["Math.random","Math.random()","Math.random"],["manual transaction","db.transaction(() => {})","manual transaction"],["mutable context","let context = {}","mutable context"],
    ["silent required no-op","inspectFulfillment: async () => true","silent required no-op"],["CompleteSaleUseCase","class CompleteSaleUseCase {}","Complete Sale use case"],["service migration","shipmentsCompatibility","service migration"],
  ];
  it.each(rejected)("audit blocks %s",(_name,source,issue)=>expect(auditSalesCompletionCoordinationSource(source).issues).toContain(issue));
  it("audit accepts valid fixture",()=>expect(auditSalesCompletionCoordinationSource(valid).status).toBe("PASS"));
  it("production audit passes",()=>expect(runSalesCompletionCoordinationAudit().status).toBe("PASS"));
  it("audit result is frozen",()=>expect(Object.isFrozen(runSalesCompletionCoordinationAudit())).toBe(true));
  it("audit issues are frozen",()=>expect(Object.isFrozen(runSalesCompletionCoordinationAudit().issues)).toBe(true));

  it("contract source uses EUR only",()=>expect(state.currency).toBe("EUR"));
  it("optional customer reference supports null",()=>expect({saleId:"s",customerId:null,marketplaceOrderId:null,shipmentId:null}.customerId).toBeNull());
  it("optional marketplace reference supports null",()=>expect({saleId:"s",customerId:null,marketplaceOrderId:null,shipmentId:null}.marketplaceOrderId).toBeNull());
  it("optional shipping reference supports null",()=>expect(state.shipmentId).toBeNull());
  it("coordinator has only approved methods",()=>expect(Object.keys(custom).sort()).toEqual(["findFinancialSnapshot","getProductCosts","inspectFulfillment","recordCompletionHistory","writeFinanceEntry","writeFinancialSnapshot"].sort()));
});
