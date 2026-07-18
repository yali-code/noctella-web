import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditMigratedSalesSurface, runSalesServiceMigrationAudit, salesServiceMigrationRules } from "../src/scripts/salesServiceMigrationAudit";
import { salesServiceMigrationMatrix } from "../src/services/salesServiceMigrationMatrix";

const fixtureByIssue:Readonly<Record<string,string>>=Object.freeze({
  SQL:"select(table)",
  DbClient:"function migrated(db: DbClient) {}",
  Drizzle:'import { eq } from "drizzle-orm"',
  schema:'import { orders } from "../db/schema"',
  "repository implementation":'import { x } from "../repositories/sales"',
  "direct repository call":"saleRepository.findById(id)",
  "manual transaction":"client.transaction(() => work())",
  "UnitOfWork ownership":"new SqliteUnitOfWork(db)",
  "Inventory access":"inventoryRepositories.products.read(id)",
  "stock mutation":"stockMovements.write.create(value)",
  "financial formula":"profit = revenue - cost",
  "readiness duplication":'issues.push("Order is unpaid")',
  "idempotency duplication":"findByIdempotencyKey(key)",
  "direct completion persistence":"saleFinancials).values(value)",
  "provider access":"stripe.completePayment()",
  "nondeterministic Date.now":"Date.now()",
  "nondeterministic randomUUID":"randomUUID()",
  "nondeterministic Math.random":"Math.random()",
  "generic patch":"query.set(input)",
  "adapter bypass":"new CompleteSaleUseCase(context)",
});

describe("Sprint 33A-S4 Sales service migration (90+ executable tests)",()=>{
  it.each(salesServiceMigrationRules)("audit rejects %s",(issue)=>{
    expect(auditMigratedSalesSurface(fixtureByIssue[issue]).issues).toContain(issue);
  });

  it.each(salesServiceMigrationMatrix)("matrix records target and decision for $functionName",(entry)=>{
    expect(entry.target.length).toBeGreaterThan(0);
    expect(["migrate","retain","reject"]).toContain(entry.decision);
  });
  it.each(salesServiceMigrationMatrix)("matrix records compatibility shapes for $functionName",(entry)=>{
    expect(entry.input).toBeTruthy();
    expect(entry.output).toBeTruthy();
    expect(entry.error).toBeTruthy();
  });
  it.each(salesServiceMigrationMatrix)("matrix records mapping and ownership for $functionName",(entry)=>{
    expect(entry.inputMapper).toBeTruthy();
    expect(entry.outputMapper).toBeTruthy();
    expect(entry.errorMapper).toBeTruthy();
    expect(entry.logic).toBeTruthy();
    expect(entry.persistence).toBeTruthy();
    expect(entry.reason).toBeTruthy();
  });

  it("production migration audit passes",()=>expect(runSalesServiceMigrationAudit()).toEqual({status:"PASS",issues:[]}));
  it("accepts a valid thin Get use-case adapter",()=>expect(auditMigratedSalesSurface("return application.getSale.execute({saleId:id})")).toEqual({status:"PASS",issues:[]}));
  it("accepts a valid thin List use-case adapter",()=>expect(auditMigratedSalesSurface("return application.listSales.execute(filters)")).toEqual({status:"PASS",issues:[]}));
  it("accepts a valid S3D adapter delegation",()=>expect(auditMigratedSalesSurface("return completeSaleAdapter.execute(orderId)")).toEqual({status:"PASS",issues:[]}));

  const composition=readFileSync(resolve(__dirname,"../src/services/salesServiceApplication.ts"),"utf8");
  it.each([
    ["approved context factory","createSalesApplicationContextForDb"],
    ["CreateSaleUseCase","new CreateSaleUseCase(context)"],
    ["UpdateSaleUseCase","new UpdateSaleUseCase(context)"],
    ["GetSaleUseCase","new GetSaleUseCase(context)"],
    ["ListSalesUseCase","new ListSalesUseCase(context)"],
    ["CancelSaleUseCase","new CancelSaleUseCase(context)"],
    ["atomic internal-sale capability","createInternalSale"],
    ["reused internal-order logic","createInternalOrderUseCase"],
    ["custom logger","dependencies.logger"],
    ["custom clock","dependencies.clock"],
    ["custom id generator","dependencies.idGenerator"],
    ["custom driver","dependencies.driver"],
  ])("composition preserves %s",(_name,fragment)=>expect(composition).toContain(fragment));

  const bridge=readFileSync(resolve(__dirname,"../src/services/erpSalesFinanceBridge.ts"),"utf8");
  const command=bridge.slice(bridge.indexOf("export async function executeSalesCommand"),bridge.indexOf("export { getSaleCompletionReadiness"));
  it.each([
    ["Get delegation","getSale.execute({saleId:id})"],
    ["List delegation","listSales.execute"],
    ["legacy page","page=Number(q.page??1)"],
    ["legacy page size","pageSize=Number(q.pageSize??50)"],
    ["status filter","status:q.orderStatus"],
    ["payment filter","paymentStatus:q.paymentStatus"],
    ["retained substring search","like(orders.orderNumber,`%${q.search}%`)"],
    ["reporting customer helper","customer:await customerProjection"],
    ["reporting financial helper","financials:await adjustedFinancials"],
    ["completion adapter path","out=await completeSale(db,id!)"],
  ])("bridge preserves %s",(_name,fragment)=>expect(bridge).toContain(fragment));
  it("ERP completion does not post finance twice",()=>expect(command).not.toContain("createFinanceEntry"));
  it("ERP complete delegates exactly once",()=>expect(command.split("out=await completeSale(db,id!)")).toHaveLength(2));
  it("create records the new atomic stock capability and S5 deferral",()=>expect(salesServiceMigrationMatrix.find(x=>x.functionName==="createInternalSale")?.reason).toContain("atomic legacy stock capability"));
  it("update absence is explicitly retained",()=>expect(salesServiceMigrationMatrix.find(x=>x.functionName==="Update Sale workflow")?.reason).toContain("no active legacy"));
  it("cancel absence is explicitly retained",()=>expect(salesServiceMigrationMatrix.find(x=>x.functionName==="Cancel Sale workflow")?.reason).toContain("no active legacy"));
  it("payment remains rejected",()=>expect(salesServiceMigrationMatrix.find(x=>x.functionName==="RecordSalePayment")?.decision).toBe("reject"));
});
