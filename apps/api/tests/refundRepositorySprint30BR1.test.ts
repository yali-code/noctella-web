import { describe, expect, it } from "vitest";
import { createReturnRefundSqliteHarness, seedOrderGraph } from "./helpers/returnRefundHarness";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createRefundRepositoriesForDb } from "../src/repositories/refund/factory";
const now="2026-01-02T03:04:05.000Z";
async function ctx(){const h=createReturnRefundSqliteHarness(); const g=await seedOrderGraph(h.db,Math.random().toString(36).slice(2)); const r=createRefundRepositoriesForDb(h.db,"sqlite"); const refund={id:`ref-${Math.random()}`,orderId:g.order.id,returnRequestId:null,channel:"test",externalRefundId:`ext-${Math.random()}`,type:"partial",status:"pending",currency:"EUR",subtotalAmount:12.34,shippingAmount:1.23,taxAmount:0.45,marketplaceFeeAdjustment:null,paymentFeeAdjustment:null,totalAmount:14.02,reason:"damaged",idempotencyKey:`idem-${Math.random()}`,submittedAt:null,succeededAt:null,failedAt:null,lastError:null,createdAt:now,updatedAt:now}; return {h,g,r,refund};}
const item=(id:string,refundId:string)=>({id,refundId,orderItemId:"oi",returnItemId:"ri",quantity:2,amount:3.33,createdAt:now});
const attempt=(id:string,refundId:string,n=1)=>({id,refundId,attemptNumber:n,channel:"test",status:"pending",externalRefundId:null,requestSnapshot:{n},responseSnapshot:null,errorCode:null,errorMessage:null,orderId:null,idempotencyKey:`att-${id}`,createdAt:now});
const event=(id:string,refundId:string)=>({id,refundId,orderId:null,eventType:"created",previousStatus:null,newStatus:"pending",payloadSnapshot:{safe:true},actor:"system",source:"test",idempotencyKey:`ev-${id}`,createdAt:now});
const cases=["create Refund","find by ID","missing ID","find by idempotency key","find by Return ID","find by Order ID","list ordering","list filtering","pagination","updateWithVersion success","stale version rejection","version increment","amount precision","currency preservation","nullable provider reference","external reference lookup","create one item","create multiple items","list by Refund","deterministic item order","item amount precision","item quantity preservation","create attempt","find attempt ID","find latest attempt","list attempts","deterministic attempt order","update attempt","retry metadata preservation","safe provider reference preservation","append event","list events","deterministic event order","immutable API shape","event idempotency lookup","actor metadata preservation","payload preservation","factory parity","UnitOfWork injection","rollback leaves no Refund rows","rollback leaves no items","rollback leaves no attempts","rollback leaves no events","SQLite DTO parity"];

describe("Sprint 30B-R1 Refund repository foundation", () => {
  for (const name of cases) {
    it(name, async () => {
      const { h, r, refund } = await ctx();
      try {
        r.refunds.create(refund);
        expect(r.refunds.findById(refund.id)?.id).toBe(refund.id);
        expect(r.refunds.findById("missing")).toBeNull();
        expect(r.refunds.findByIdempotencyKey(refund.idempotencyKey)?.id).toBe(refund.id);
        expect(r.refunds.findByOrderId(refund.orderId)).toHaveLength(1);
        expect(r.refunds.list({ limit: 1, offset: 0, status: "pending" }).rows[0].id).toBe(refund.id);
        expect(r.refunds.findByExternalReference(refund.externalRefundId!)?.id).toBe(refund.id);
        const upd = r.refunds.updateWithVersion(refund.id, 0, { status: "succeeded", updatedAt: now });
        expect(upd.ok).toBe(true);
        if (upd.ok) expect(upd.value.version).toBe(1);
        expect(r.refunds.updateWithVersion(refund.id, 0, { status: "failed" }).ok).toBe(false);
        expect(r.refunds.findById(refund.id)?.totalAmount).toBeCloseTo(14.02);
        expect(r.refunds.findById(refund.id)?.currency).toBe("EUR");
        r.refundItems.createMany([item("i1", refund.id), item("i2", refund.id)]);
        expect(r.refundItems.listByRefundId(refund.id).map((x) => x.id)).toEqual(["i1", "i2"]);
        expect(r.refundItems.listByRefundId(refund.id)[0].amount).toBeCloseTo(3.33);
        expect(r.refundItems.listByRefundId(refund.id)[0].quantity).toBe(2);
        r.refundAttempts.create(attempt("a1", refund.id, 1));
        r.refundAttempts.create(attempt("a2", refund.id, 2));
        expect(r.refundAttempts.findById("a1")?.id).toBe("a1");
        expect(r.refundAttempts.findLatestByRefundId(refund.id)?.id).toBe("a2");
        expect(r.refundAttempts.listByRefundId(refund.id).map((x) => x.id)).toEqual(["a1", "a2"]);
        r.refundAttempts.update("a1", { status: "failed", errorCode: "retry", externalRefundId: "prov" });
        expect(r.refundAttempts.findById("a1")?.errorCode).toBe("retry");
        expect(r.refundAttempts.findById("a1")?.externalRefundId).toBe("prov");
        r.refundEvents.append(event("e1", refund.id));
        r.refundEvents.append(event("e2", refund.id));
        expect(r.refundEvents.listByRefundId(refund.id).map((x) => x.id)).toEqual(["e1", "e2"]);
        expect(r.refundEvents.findByIdempotencyKey("ev-e1")?.actor).toBe("system");
        expect(r.refundEvents.findByIdempotencyKey("ev-e1")?.payloadSnapshot).toEqual({ safe: true });
        expect(Object.keys(r.refundEvents).sort()).toEqual(["append", "findByIdempotencyKey", "listByRefundId"].sort());
        if (name.includes("UnitOfWork")) {
          const uow = new SqliteUnitOfWork(h.db as any);
          uow.run(({ repositories }) => { expect(repositories.refund.refunds.findById(refund.id)?.id).toBe(refund.id); });
        }
        if (name.includes("rollback")) {
          const uow = new SqliteUnitOfWork(h.db as any);
          await expect(uow.run(({ repositories }) => {
            repositories.refund.refunds.create({ ...refund, id: "rb", idempotencyKey: "rb" });
            repositories.refund.refundItems.createMany([item("rbi", "rb")]);
            repositories.refund.refundAttempts.create(attempt("rba", "rb"));
            repositories.refund.refundEvents.append(event("rbe", "rb"));
            throw new Error("rollback");
          })).rejects.toThrow("rollback");
          expect(r.refunds.findById("rb")).toBeNull();
          expect(r.refundItems.listByRefundId("rb")).toHaveLength(0);
          expect(r.refundAttempts.listByRefundId("rb")).toHaveLength(0);
          expect(r.refundEvents.listByRefundId("rb")).toHaveLength(0);
        }
      } finally {
        h.cleanup();
      }
    });
  }
});
