import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createReturnRefundSqliteHarness, seedOrderGraph, seedReturn, seedRefund } from "./helpers/returnRefundHarness";

describe("createReturnRefundSqliteHarness :memory: migration (Sprint 53B)", () => {
  it("A: still produces the full schema, real repository-backed writes, and working seed helpers", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      // In-memory now, not a real file on disk.
      expect(h.path).toBe(":memory:");
      const tables = h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("return_requests");
      expect(names).toContain("refunds");
      expect(names).toContain("orders");

      const graph = await seedOrderGraph(h.db, "harness-a");
      expect(graph.order.id).toBeTruthy();
      expect(graph.product.id).toBeTruthy();

      const ret = await seedReturn(h.db, graph, { status: "completed", quantityApproved: 1, quantityReceived: 1 });
      expect(ret.returnRequest.orderId).toBe(graph.order.id);
      const [storedReturn] = await h.db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id, ret.returnRequest.id));
      expect(storedReturn.status).toBe("completed");

      const refund = await seedRefund(h.db, graph, ret, { status: "succeeded", totalAmount: 120 });
      const [storedRefund] = await h.db.select().from(schema.refunds).where(eq(schema.refunds.id, refund.refund.id));
      expect(storedRefund.totalAmount).toBe(120);
    } finally {
      h.cleanup();
    }
  });
});
