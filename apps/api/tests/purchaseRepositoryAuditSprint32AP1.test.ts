import { describe,it,expect } from "vitest"; import { auditPurchaseRepositorySources } from "../src/scripts/purchaseRepositoryAudit";
describe("purchase repository audit Sprint 32A-P1",()=>{
 it("production audit passes",()=>expect(auditPurchaseRepositorySources()).toEqual([]));
 it("DbClient contract fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",contract:true,content:"export interface X{db:DbClient}"}])).not.toEqual([]));
 it("raw query fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",contract:true,content:"rawQuery(sql:string):unknown"}])).not.toEqual([]));
 it("transaction creation fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",content:"db.transaction(()=>{})"}])).not.toEqual([]));
 it("inventory mutation fixture fails",()=>expect(auditPurchaseRepositorySources([{path:"x",content:"applyStockMovement(input)"}])).not.toEqual([]));
});
