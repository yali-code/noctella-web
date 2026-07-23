import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { seedOrderGraph, seedReturn, seedRefund } from "./helpers/returnRefundHarness";
import { reverseCompletedSale } from "../src/services/returnsCompatibility";
import { ConflictError } from "../src/services/errors";
import { saleReversals, financeEntries } from "../src/db/schema";

/**
 * Seeds an order whose full quantity has been returned (status "completed")
 * and fully refunded (status "succeeded", amount equal to the order total),
 * which is exactly what getSaleReversalReadiness requires before a sale
 * reversal is allowed.
 */
async function seedReadyOrder(db: ReturnType<typeof createTestDb>) {
  const graph = await seedOrderGraph(db, Math.random().toString(36).slice(2));
  const ret = await seedReturn(db, graph, { status: "completed", quantityRequested: 1, quantityApproved: 1, quantityReceived: 1 });
  const refund = await seedRefund(db, graph, ret, { status: "succeeded", totalAmount: 120 });
  return { graph, ret, refund };
}

describe("reverseCompletedSale atomicity (Sprint 52B)", () => {
  it("F: creates a sale reversal and finance entry atomically; identical-payload replay returns the stored result without a duplicate finance entry", async () => {
    const db = createTestDb();
    const { graph, ret, refund } = await seedReadyOrder(db);
    const input = { orderId: graph.order.id, returnRequestId: ret.returnRequest.id, refundId: refund.refund.id, idempotencyKey: `sale-reversal:${graph.order.id}` };
    const result: any = await reverseCompletedSale(db, input);
    expect(result.orderId).toBe(graph.order.id);
    expect(await db.select().from(saleReversals)).toHaveLength(1);
    const entries = await db.select().from(financeEntries).where(eq(financeEntries.saleReversalId, result.id));
    expect(entries).toHaveLength(1);

    const replay: any = await reverseCompletedSale(db, { ...input });
    expect(replay.id).toBe(result.id);
    expect(await db.select().from(saleReversals)).toHaveLength(1);
    expect(await db.select().from(financeEntries).where(eq(financeEntries.saleReversalId, result.id))).toHaveLength(1);
  });

  it("G: the same idempotency key with a different semantic payload conflicts and writes nothing", async () => {
    const db = createTestDb();
    const { graph, ret, refund } = await seedReadyOrder(db);
    const key = `sale-reversal:${graph.order.id}`;
    const first: any = await reverseCompletedSale(db, { orderId: graph.order.id, returnRequestId: ret.returnRequest.id, refundId: refund.refund.id, idempotencyKey: key });

    await expect(reverseCompletedSale(db, { orderId: graph.order.id, returnRequestId: null, refundId: refund.refund.id, idempotencyKey: key })).rejects.toBeInstanceOf(ConflictError);

    const rows = await db.select().from(saleReversals);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].returnRequestId).toBe(ret.returnRequest.id);
    expect(await db.select().from(financeEntries)).toHaveLength(1);
  });

  it("H: a deterministic finance-entry failure rolls back the sale reversal too", async () => {
    const db = createTestDb();
    const { graph, ret, refund } = await seedReadyOrder(db);
    (db as any).$client.exec("CREATE TRIGGER fail_finance_entry BEFORE INSERT ON finance_entries BEGIN SELECT RAISE(ABORT, 'finance entry insert failed'); END");
    let caught: any;
    try {
      await reverseCompletedSale(db, { orderId: graph.order.id, returnRequestId: ret.returnRequest.id, refundId: refund.refund.id });
    } catch (e) {
      caught = e;
    } finally {
      (db as any).$client.exec("DROP TRIGGER fail_finance_entry");
    }
    expect(caught).toBeTruthy();
    expect(String(caught?.cause?.message ?? caught?.message)).toContain("finance entry insert failed");
    expect(await db.select().from(saleReversals)).toHaveLength(0);
    expect(await db.select().from(financeEntries)).toHaveLength(0);
  });
});
