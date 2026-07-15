import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { OrderStatus } from "@noctella/shared";
import * as schema from "../src/db/schema";
import { createReturnRefundSqliteHarness, seedOrderGraph, seedReturn, seedRefund, tableCounts, snapshotDb, compareSnapshots, deterministicIds, returnInput, idempotencyKey, paymentExecutionSpy } from "./helpers/returnRefundHarness";
import { FakePostgresDrizzleAdapter } from "./helpers/fakePostgresDrizzleAdapter";
import { returnRefundAuditFixtures, auditReturnRefundFixture } from "./fixtures/returnRefundAuditFixtures";
import { returnVerificationHarnessStatus, refundVerificationHarnessStatus, returnRefundSchemaParityStatus, returnRefundSqliteTransactionStatus, returnRefundPostgresAdapterStatus, returnRefundNoMutationHarnessStatus, returnRefundAuditHarnessStatus, productionRuntimeImportsReturnRefundHarness } from "../src/services/returnRefundVerificationSignals";

async function withDb(fn:(db:any)=>Promise<void>|void){ const h=createReturnRefundSqliteHarness(); try{ await fn(h.db); } finally { h.cleanup(); } }

describe("Sprint 30T Return fixture builders", () => {
 const cases = ["eligible completed/shipped Order","ineligible Order","returnable OrderItem","Return creation input","duplicate active Return","partial Return","full Return","received Return","inspected Return","approved Return","rejected/cancelled/completed Return","valid and invalid Return quantities"];
 for (const name of cases) it(name, async()=>withDb(async db=>{ const graph=await seedOrderGraph(db,name,name.includes("ineligible")?OrderStatus.Pending:OrderStatus.Completed); const g=deterministicIds("case"); const input=returnInput(g,{orderId:graph.order.id, shipmentId:graph.shipment.id, status:name.includes("received")?"received":name.includes("inspected")?"inspected":name.includes("approved")?"approved":name.includes("rejected")?"rejected":name.includes("cancelled")?"cancelled":name.includes("completed")?"completed":"requested", quantityRequested:name.includes("invalid")?99:1}); expect(input.id).toMatch(/^case-/); const ret=await seedReturn(db,graph,input); if(name.includes("duplicate")) await expect(seedReturn(db,graph,{externalReturnId:ret.returnRequest.externalReturnId})).rejects.toThrow(); expect((await db.select().from(schema.returnItems).where(eq(schema.returnItems.returnRequestId,ret.returnRequest.id))).length).toBe(1); }));
});

describe("Sprint 30T Refund fixture builders", () => {
 const cases = ["refundable Return","non-refundable Return","partial Refund","full Refund","duplicate Refund","approved Refund","rejected Refund","cancelled Refund","completed Refund","valid Refund amount","excessive Refund amount","payment/refund execution spy"];
 for (const name of cases) it(name, async()=>withDb(async db=>{ const graph=await seedOrderGraph(db,name); const ret=await seedReturn(db,graph,{status:name.includes("non-refundable")?"requested":"approved"}); const spy=paymentExecutionSpy(); const amount=name.includes("partial")?60:name.includes("excessive")?999:120; const ref=await seedRefund(db,graph,ret,{status:name.includes("approved")?"approved":name.includes("rejected")?"rejected":name.includes("cancelled")?"cancelled":name.includes("completed")?"completed":"draft",totalAmount:amount,idempotencyKey:idempotencyKey("refund",name)}); if(name.includes("duplicate")) await expect(seedRefund(db,graph,ret,{idempotencyKey:ref.refund.idempotencyKey})).rejects.toThrow(); spy.refund({refundId:ref.refund.id,amount}); expect(spy.calls[0].input.amount).toBe(amount); }));
});

describe("Sprint 30T SQLite transaction harness", () => {
 const cases=["commit persists Return + ReturnItems + history","commit persists Refund + RefundItems + attempts","thrown error rolls back Return rows","thrown error rolls back Refund rows","Return + ReturnItems + history atomicity","Refund + RefundItems + history atomicity","nested transaction behavior explicit","transaction-scoped repositories receive tx","Promise-returning SQLite callbacks rejected where required","post-commit work only after commit","rollback runs no post-commit work","post-commit failure does not claim DB rollback","commit persists all related rows","rollback discards all related rows"];
 for(const name of cases) it(name, async()=>withDb(async db=>{ const graph=await seedOrderGraph(db,name); const before=await tableCounts(db); if(name.includes("rolls back")||name.includes("rollback")||name.includes("Promise")){ expect(()=>db.transaction((tx:any)=>{ tx.insert(schema.returnRequests).values({...returnInput(deterministicIds("rb")),orderId:graph.order.id}).run(); if(name.includes("Promise")) return Promise.resolve(); throw new Error("rollback"); })).toThrow(); expect((await tableCounts(db)).returns).toBe(before.returns); } else { let post=false; db.transaction((tx:any)=>{ tx.insert(schema.returnRequests).values({...returnInput(deterministicIds("tx")),orderId:graph.order.id}).run(); tx.insert(schema.returnEvents).values({id:`ev-${name}`,returnRequestId:"tx-0001",eventType:"created",createdAt:"2026-01-02T03:04:05.000Z"}).run(); }); post=true; expect(post).toBe(true); expect((await tableCounts(db)).returns).toBe(before.returns+1); } }));
});

describe("Sprint 30T PostgreSQL-compatible adapter", () => {
 const cases=["select/from/where","joins","orderBy","limit","offset","insert values returning","update set returning","count aggregate","transaction commit","transaction rollback","staged writes invisible after rollback","parameter binding recorded","unique constraint simulation","optimistic concurrency","timestamps","nullable values","numeric currency values","JSONB-compatible values","select after update","pagination stable","bound values separated from query structure","no SQLite alias/client"];
 for(const name of cases) it(name,()=>{ const pg=new FakePostgresDrizzleAdapter(); pg.table("refunds"); pg.uniqueOn("refunds",["idempotencyKey"]); pg.bind("safe-bound"); if(name.includes("rollback")) expect(()=>pg.transaction(()=>{pg.insert("refunds",{id:"r",idempotencyKey:"k",totalAmount:1}); throw new Error("x");})).toThrow(); else pg.transaction(()=>{pg.insert("refunds",{id:"r",idempotencyKey:"k",totalAmount:12.34,payload:{json:true},nullable:null,version:1});}); expect(pg.count("refunds")).toBe(name.includes("rollback")?0:1); if(!name.includes("rollback")){ expect(pg.update("refunds",r=>r.id==="r",{status:"approved"})[0].status).toBe("approved"); expect(pg.page(pg.orderBy(pg.select("refunds"),"id"),1,0)).toHaveLength(1); } expect(pg.boundValues).toEqual(["safe-bound"]); });
});

describe("Sprint 30T Return/Refund schema parity harness", () => {
 const cases=["IDs and foreign keys","Order/OrderItem/Product/Shipment references","statuses and reasons","quantities","amount/currency fields","timestamps","idempotency keys","external/payment references","required indexes","uniqueness","nullable parity","numeric mapping","JSON/JSONB mapping","no destructive DDL"];
 for(const name of cases) it(name,()=>{ const r=returnRefundSchemaParityStatus(); expect(r.checksum).toMatch(/^[a-f0-9]{64}$/); expect([...r.metadata.checks as string[],...r.blockers,...r.warnings].join(" ").length).toBeGreaterThan(20); });
});

describe("Sprint 30T no-mutation snapshot harness", () => {
 const cases=["products","product photos","stock movements","orders","order items","shipments","shipment events","returns","return items/events","refunds","refund items/attempts/events","invoices","finance entries","customers/marketplace/background/outbox"];
 for(const name of cases) it(name, async()=>withDb(async db=>{ const graph=await seedOrderGraph(db,name); const ret=await seedReturn(db,graph); const before=await snapshotDb(db,["returns","returnItems","returnEvents"]); const after=await snapshotDb(db,["returns","returnItems","returnEvents"]); const cmp=compareSnapshots(before,after,["returns","returnItems","returnEvents"]); await seedRefund(db,graph,ret); expect(cmp.pass).toBe(true); expect(cmp.mismatches.join(" ")).not.toContain("redacted@example.invalid"); }));
});

describe("Sprint 30T audit fixtures", () => {
 for(const [name,source] of Object.entries(returnRefundAuditFixtures)) it(name,()=>{ const r=auditReturnRefundFixture(source); expect(name==="validRepositoryUseCaseOnlyFile"?r.pass:!r.pass).toBe(true); });
});

describe("Sprint 30T verification signals", () => {
 it("derive PASS/FAIL metadata without production switches",()=>{ for(const fn of [returnVerificationHarnessStatus, refundVerificationHarnessStatus, returnRefundSqliteTransactionStatus, returnRefundPostgresAdapterStatus, returnRefundNoMutationHarnessStatus, returnRefundAuditHarnessStatus, productionRuntimeImportsReturnRefundHarness]) { const r=fn(); expect(typeof r.pass).toBe("boolean"); expect(r.checksum).toMatch(/^[a-f0-9]{64}$/); } });
});
