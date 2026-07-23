import { describe, expect, it } from "vitest";
import { createRefundUseCase, executeRefundUseCase, retryRefundUseCase, submitRefundUseCase } from "../src/use-cases/refund";

// Same lightweight in-memory repo/context shape as tests/refundUseCasesSprint30BR3.test.ts,
// duplicated locally (not shared/imported) per this codebase's existing per-file convention.
const t = "2026-01-01T00:00:00.000Z";
function repo() {
  const refunds: any[] = []; const items: any[] = []; const attempts: any[] = []; const events: any[] = [];
  return {
    refunds: {
      create: (x: any) => (refunds.push({ ...x }), x),
      findById: (id: string) => refunds.find(r => r.id === id) ?? null,
      findByIdempotencyKey: (k: string) => refunds.find(r => r.idempotencyKey === k) ?? null,
      findByOrderId: (id: string) => refunds.filter(r => r.orderId === id),
      list: () => ({ rows: refunds, total: refunds.length, limit: 50, offset: 0 }),
      updateWithVersion: (id: string, v: number, p: any) => { const r = refunds.find(r => r.id === id); if (!r) return { ok: false, issue: { code: "not_found", message: "no" } }; if (r.version !== v) return { ok: false, issue: { code: "optimistic_conflict", message: "stale" } }; Object.assign(r, p, { version: v + 1 }); return { ok: true, value: r }; },
    },
    refundItems: { createMany: (xs: any[]) => { items.push(...xs); return xs; }, listByRefundId: (id: string) => items.filter(i => i.refundId === id) },
    refundAttempts: { create: (x: any) => (attempts.push(x), x), findLatestByRefundId: (id: string) => attempts.filter(a => a.refundId === id).at(-1) ?? null, listByRefundId: (id: string) => attempts.filter(a => a.refundId === id), update: (id: string, p: any) => { const a = attempts.find(a => a.id === id); return a ? Object.assign(a, p) : null; } },
    refundEvents: { append: (x: any) => (events.push(x), x), listByRefundId: (id: string) => events.filter(e => e.refundId === id), findByIdempotencyKey: (k: string) => events.find(e => e.idempotencyKey === k) ?? null },
    _: { refunds, items, attempts, events },
  };
}
function ctx(o: any = {}) {
  const r = o.repos ?? repo(); let ids = 0;
  const order = { id: "o1", currency: "EUR", totalAmount: 100 };
  const enq: any[] = []; const calls: any[] = [];
  return {
    ctx: {
      unitOfWork: { run: async (fn: any) => fn({ repositories: { refund: r } }) },
      repositories: r,
      readPorts: {
        orders: { findRefundOrder: () => order, findRefundItems: () => [{ id: "oi1", orderId: "o1", quantity: 2, refundableAmount: 100, currency: "EUR" }] },
        returns: { findApprovedReturn: () => null, findApprovedItems: () => [] },
        marketplaceConnections: { findConnection: () => ({ id: "c", orderId: "o1", marketplace: "eBay", providerKey: "mk" }), resolveProvider: (c: any) => c.providerKey },
        payments: { findPayment: () => ({ id: "p", orderId: "o1", providerKey: "pay", currency: "EUR", capturedAmount: 100, refundedAmount: 0 }), findRemainingRefundAmount: () => 100 },
      },
      providerPorts: {
        resolveMarketplaceProvider: () => ({ executeRefund: async (req: any) => (calls.push(["market", req]), { providerRefundId: "ext", status: "succeeded" }), cancelRefund: async (id: string) => ({ providerRefundId: id, status: "cancelled" }), getRefundStatus: async (id: string) => ({ providerRefundId: id, status: "ok" }) }),
        resolvePaymentProvider: () => ({ executeRefund: async (req: any) => (calls.push(["pay", req]), { providerRefundId: "pay-ext", status: "succeeded" }), cancelRefund: async (id: string) => ({ providerRefundId: id, status: "cancelled" }), getRefundStatus: async (id: string) => ({ providerRefundId: id, status: "ok" }) }),
      },
      clock: { now: () => new Date(t) },
      idGenerator: { newId: () => `id${++ids}` },
      enqueue: { enqueueRefundExecution: (id: string) => enq.push(id), cancelRefundExecution: (id: string) => enq.push(`cancel:${id}`) },
      logger: { warn: () => {} },
      errorNormalizer: { normalize: (e: any) => ({ code: e?.code ?? "Provider", message: e?.message ?? "provider", cause: e }) },
    },
    r, enq, calls,
  };
}
async function made(c: any, input: any = {}) { return createRefundUseCase(c.ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 10, idempotencyKey: `k${Math.random()}`, ...input }); }
/** Arranges a refund that looks like it was claimed (Pending -> Processing) but never reached an outcome, at the given age in milliseconds relative to the fixed clock `t`. */
async function stuckProcessing(c: any, ageMs: number, channel?: string) {
  const a = await made(c, channel ? { channel } : {});
  await submitRefundUseCase(c.ctx, { refundId: a.refund.id });
  const refund = c.r._.refunds[0];
  refund.status = "processing";
  refund.updatedAt = new Date(new Date(t).getTime() - ageMs).toISOString();
  const attempt = c.r._.attempts.at(-1);
  if (attempt) attempt.status = "processing";
  return a;
}

describe("refund stale Processing recovery (Sprint 52B)", () => {
  it("A: recent Processing rejects with the existing invalid-status error and performs no mutation", async () => {
    const c = ctx();
    const a = await stuckProcessing(c, 30_000);
    const versionBefore = c.r._.refunds[0].version;
    const attemptsBefore = c.r._.attempts.length;
    const eventsBefore = c.r._.events.length;
    await expect(executeRefundUseCase(c.ctx, { refundId: a.refund.id })).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
    expect(c.r._.refunds[0].status).toBe("processing");
    expect(c.r._.refunds[0].version).toBe(versionBefore);
    expect(c.calls).toHaveLength(0);
    expect(c.r._.attempts).toHaveLength(attemptsBefore);
    expect(c.r._.events).toHaveLength(eventsBefore);
  });

  it("B: stale Processing (>=60s) recovers to Failed atomically and requires explicit retry", async () => {
    const c = ctx();
    const a = await stuckProcessing(c, 61_000);
    const versionBefore = c.r._.refunds[0].version;
    await expect(executeRefundUseCase(c.ctx, { refundId: a.refund.id })).rejects.toMatchObject({ code: "STALE_PROCESSING_RECOVERED" });
    expect(c.r._.refunds[0].status).toBe("failed");
    expect(c.r._.refunds[0].version).toBe(versionBefore + 1);
    expect(c.r._.refunds[0].updatedAt).toBe(t);
    expect(c.calls).toHaveLength(0);
    const failEvents = c.r._.events.filter((e: any) => e.eventType === "RefundFailed");
    expect(failEvents).toHaveLength(1);
    expect(c.r._.attempts.at(-1).status).toBe("failed");
  });

  it("C: after recovery, retryRefund resumes and a later execute goes through the real provider only then", async () => {
    const c = ctx();
    const a = await stuckProcessing(c, 61_000, "eBay");
    await expect(executeRefundUseCase(c.ctx, { refundId: a.refund.id })).rejects.toMatchObject({ code: "STALE_PROCESSING_RECOVERED" });
    const recoveryEventCount = c.r._.events.filter((e: any) => e.eventType === "RefundFailed").length;
    const retried = await retryRefundUseCase(c.ctx, { refundId: a.refund.id });
    expect(retried.refund.status).toBe("pending");
    expect(c.calls).toHaveLength(0);
    const result = await executeRefundUseCase(c.ctx, { refundId: a.refund.id });
    expect(result.refund.status).toBe("succeeded");
    expect(c.calls).toHaveLength(1);
    expect(c.r._.events.filter((e: any) => e.eventType === "RefundFailed").length).toBe(recoveryEventCount);
  });

  it("D: stale recovery still enforces optimistic concurrency and does not blindly overwrite", async () => {
    const c = ctx();
    const a = await stuckProcessing(c, 61_000);
    c.ctx.repositories.refunds.updateWithVersion = () => ({ ok: false, issue: { code: "optimistic_conflict", message: "stale" } });
    await expect(executeRefundUseCase(c.ctx, { refundId: a.refund.id })).rejects.toMatchObject({ code: "STALE_REFUND_VERSION" });
    expect(c.r._.refunds[0].status).toBe("processing");
    expect(c.calls).toHaveLength(0);
  });

  it("E: normal Pending refund execution is unaffected by the recovery branch", async () => {
    const c = ctx();
    const a = await made(c, { channel: "eBay" });
    await submitRefundUseCase(c.ctx, { refundId: a.refund.id });
    const result = await executeRefundUseCase(c.ctx, { refundId: a.refund.id });
    expect(result.refund.status).toBe("succeeded");
    expect(c.calls).toHaveLength(1);
    expect(c.r._.attempts).toHaveLength(1);
  });
});
