import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createReturnRefundSqliteHarness, seedOrderGraph, deterministicClock } from "./helpers/returnRefundHarness";
import { createRefundRepositoriesForDb } from "../src/repositories/refund/factory";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createRefundApplicationContext } from "../src/services/refundApplicationContext";
import { createRefundUseCase, executeRefundUseCase, retryRefundUseCase, submitRefundUseCase } from "../src/use-cases/refund";

/**
 * Sprint 56B: proves the exactly-once finance-ledger invariant for the async
 * submit -> background-execute path (the realistic production path, distinct
 * from refundsCompatibility.createRefund's synchronous create-as-succeeded
 * path which already posted a ledger entry before this sprint). Uses a real
 * in-memory SQLite db + the real SqliteUnitOfWork/refund repositories so the
 * transaction-scoped `repositories.db` that executeRefundUseCase now writes
 * finance entries through is genuine, not faked.
 */
function buildContext(h: ReturnType<typeof createReturnRefundSqliteHarness>, opts: { fail?: boolean } = {}) {
  const calls: any[] = [];
  const enq: string[] = [];
  const ctx = createRefundApplicationContext({
    unitOfWork: new SqliteUnitOfWork(h.db as any),
    repositories: createRefundRepositoriesForDb(h.db as any, "sqlite"),
    readPorts: {
      orders: {
        findRefundOrder: () => ({ id: "o1", currency: "EUR", totalAmount: 120 }),
        findRefundItems: () => [{ id: "oi1", orderId: "o1", quantity: 1, refundableAmount: 120, currency: "EUR" }],
      },
      returns: { findApprovedReturn: () => null, findApprovedItems: () => [] },
      marketplaceConnections: { findConnection: () => null, resolveProvider: (c: any) => c.providerKey },
      payments: { findPayment: () => null, findRemainingRefundAmount: () => 120 },
    },
    providerPorts: {
      resolveMarketplaceProvider: () => ({
        executeRefund: async (req: any) => {
          calls.push(req);
          if (opts.fail) throw Object.assign(new Error("provider down"), { retryable: true });
          return { providerRefundId: `ext-${req.refundId}`, status: "succeeded" };
        },
        cancelRefund: async (id: string) => ({ providerRefundId: id, status: "cancelled" }),
        getRefundStatus: async (id: string) => ({ providerRefundId: id, status: "ok" }),
      }),
      resolvePaymentProvider: async () => { throw new Error("REFUND_PAYMENT_PROVIDER_NOT_CONFIGURED"); },
    } as any,
    clock: { now: () => deterministicClock.now() },
    idGenerator: { newId: () => randomUUID() },
    enqueue: { enqueueRefundExecution: (id: string) => enq.push(id), cancelRefundExecution: (id: string) => enq.push(`cancel:${id}`) },
    logger: { warn: () => {} },
    errorNormalizer: { normalize: (e: any) => ({ code: e?.code ?? "Provider", message: e?.message ?? "provider", cause: e }) },
  });
  return { ctx, calls, enq };
}

async function ledgerEntries(h: ReturnType<typeof createReturnRefundSqliteHarness>, refundId: string) {
  return h.db.select().from(schema.financeEntries).where(eq(schema.financeEntries.refundId, refundId));
}

describe("refund finance-ledger exactly-once integrity (Sprint 56B)", () => {
  it("A: asynchronous successful refund (submit -> execute) creates exactly one finance posting", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const { ctx } = buildContext(h);
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, channel: "eBay", idempotencyKey: "k-a" });
      await submitRefundUseCase(ctx, { refundId: created.refund.id });
      const result = await executeRefundUseCase(ctx, { refundId: created.refund.id });
      expect(result.refund.status).toBe("succeeded");
      const entries = await ledgerEntries(h, created.refund.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe("SuccessfulRefund");
      expect(entries[0].amount).toBe(120);
      expect(entries[0].idempotencyKey).toBe(`successful-refund:${created.refund.id}`);
    } finally { h.cleanup(); }
  });

  it("B: retry after a failed attempt does not duplicate the finance posting", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const failing = buildContext(h, { fail: true });
      const created = await createRefundUseCase(failing.ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, channel: "eBay", idempotencyKey: "k-b" });
      await submitRefundUseCase(failing.ctx, { refundId: created.refund.id });
      await expect(executeRefundUseCase(failing.ctx, { refundId: created.refund.id })).rejects.toMatchObject({ code: "PROVIDER_RETRYABLE_FAILURE" });
      expect(await ledgerEntries(h, created.refund.id)).toHaveLength(0);

      const succeeding = buildContext(h);
      await retryRefundUseCase(succeeding.ctx, { refundId: created.refund.id });
      const result = await executeRefundUseCase(succeeding.ctx, { refundId: created.refund.id });
      expect(result.refund.status).toBe("succeeded");
      const entries = await ledgerEntries(h, created.refund.id);
      expect(entries).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("C: repeated/idempotent execution of an already-succeeded refund does not duplicate the posting", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const { ctx } = buildContext(h);
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, channel: "eBay", idempotencyKey: "k-c" });
      await submitRefundUseCase(ctx, { refundId: created.refund.id });
      await executeRefundUseCase(ctx, { refundId: created.refund.id });
      const again = await executeRefundUseCase(ctx, { refundId: created.refund.id });
      expect(again.refund.status).toBe("succeeded");
      expect(await ledgerEntries(h, created.refund.id)).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("D: a failed refund creates no success posting", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const { ctx } = buildContext(h, { fail: true });
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, channel: "eBay", idempotencyKey: "k-d" });
      await submitRefundUseCase(ctx, { refundId: created.refund.id });
      await expect(executeRefundUseCase(ctx, { refundId: created.refund.id })).rejects.toMatchObject({ code: "PROVIDER_RETRYABLE_FAILURE" });
      expect(await ledgerEntries(h, created.refund.id)).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("E: stale-Processing recovery followed by a real retry preserves exactly-once accounting", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const { ctx } = buildContext(h);
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, channel: "eBay", idempotencyKey: "k-e" });
      await submitRefundUseCase(ctx, { refundId: created.refund.id });
      const [row] = await h.db.select().from(schema.refunds).where(eq(schema.refunds.id, created.refund.id));
      await h.db.update(schema.refunds).set({ status: "processing", updatedAt: new Date(deterministicClock.now().getTime() - 61_000).toISOString() }).where(eq(schema.refunds.id, created.refund.id)).run();
      await expect(executeRefundUseCase(ctx, { refundId: created.refund.id })).rejects.toMatchObject({ code: "STALE_PROCESSING_RECOVERED" });
      expect(await ledgerEntries(h, created.refund.id)).toHaveLength(0);
      await retryRefundUseCase(ctx, { refundId: created.refund.id });
      const result = await executeRefundUseCase(ctx, { refundId: created.refund.id });
      expect(result.refund.status).toBe("succeeded");
      expect(await ledgerEntries(h, created.refund.id)).toHaveLength(1);
    } finally { h.cleanup(); }
  });
});
