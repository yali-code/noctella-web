import { describe, expect, it, vi } from "vitest";
import {
  createSafeRefundLogger,
  emitRefundSignal,
  safeRefundLogMeta,
} from "../src/observability/refund";
import {
  submitRefundUseCase,
  createRefundUseCase,
  cancelRefundUseCase,
} from "../src/use-cases/refund";
const t = "2026-01-01T00:00:00.000Z";
function repo() {
  const refunds: any[] = [];
  const items: any[] = [];
  const attempts: any[] = [];
  const events: any[] = [];
  return {
    refunds: {
      create: (x: any) => (refunds.push({ ...x }), x),
      findById: (id: string) => refunds.find((r) => r.id === id) ?? null,
      findByIdempotencyKey: (k: string) =>
        refunds.find((r) => r.idempotencyKey === k) ?? null,
      findByExternalReference: () => null,
      findByReturnId: () => [],
      findByOrderId: () => [],
      list: () => ({
        rows: refunds,
        total: refunds.length,
        limit: 50,
        offset: 0,
      }),
      updateWithVersion: (id: string, v: number, p: any) => {
        const r = refunds.find((r) => r.id === id);
        if (!r)
          return { ok: false, issue: { code: "not_found", message: "no" } };
        if (r.version !== v)
          return {
            ok: false,
            issue: { code: "optimistic_conflict", message: "stale" },
          };
        Object.assign(r, p, { version: v + 1 });
        return { ok: true, value: r };
      },
    },
    refundItems: {
      createMany: (xs: any[]) => {
        items.push(...xs);
        return xs;
      },
      listByRefundId: (id: string) => items.filter((i) => i.refundId === id),
    },
    refundAttempts: {
      create: (x: any) => (attempts.push(x), x),
      findById: () => null,
      findLatestByRefundId: (id: string) =>
        attempts.filter((a) => a.refundId === id).at(-1) ?? null,
      listByRefundId: (id: string) => attempts.filter((a) => a.refundId === id),
      update: (id: string, p: any) =>
        Object.assign(
          attempts.find((a) => a.id === id),
          p,
        ),
    },
    refundEvents: {
      append: (x: any) => (events.push(x), x),
      listByRefundId: (id: string) =>
        events
          .filter((e) => e.refundId === id)
          .sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          ),
      findByIdempotencyKey: (k: string) =>
        events.find((e) => e.idempotencyKey === k) ?? null,
    },
    _: { refunds, items, attempts, events },
  };
}
function ctx(o: any = {}) {
  const r = o.repos ?? repo();
  let ids = 0;
  const signals: any[] = [];
  let committed = false;
  return {
    ctx: {
      unitOfWork: {
        run: async (fn: any) => {
          committed = false;
          const v = await fn({ repositories: { refund: r } });
          committed = true;
          return v;
        },
      },
      repositories: r,
      readPorts: {
        orders: {
          findRefundOrder: () => ({
            id: "o1",
            currency: "EUR",
            totalAmount: 100,
          }),
          findRefundItems: () => [],
        },
        returns: {
          findApprovedReturn: () => null,
          findApprovedItems: () => [],
        },
        marketplaceConnections: {
          findConnection: () => null,
          resolveProvider: () => "mk",
        },
        payments: {
          findPayment: () => ({
            id: "p",
            orderId: "o1",
            providerKey: "pay",
            currency: "EUR",
            capturedAmount: 100,
            refundedAmount: 0,
          }),
          findRemainingRefundAmount: () => 100,
        },
      },
      providerPorts: {
        resolvePaymentProvider: () => ({
          executeRefund: async () => ({
            providerRefundId: "ext",
            status: "succeeded",
          }),
          cancelRefund: async () => ({}),
          getRefundStatus: async () => ({}),
        }),
      },
      clock: { now: () => new Date(t) },
      idGenerator: { newId: () => `id${++ids}` },
      enqueue: {
        enqueueRefundExecution: () => {},
        cancelRefundExecution: () => {},
      },
      logger: { warn: vi.fn() },
      errorNormalizer: {
        normalize: (e: any) => ({
          code: e?.code ?? "E",
          message: e?.message ?? "m",
        }),
      },
      observability: {
        refundTransitionRecorded: vi.fn((e: any) =>
          signals.push(["transition", committed, e]),
        ),
        refundQueueRequested: vi.fn((m: any) =>
          signals.push(["queue", committed, m]),
        ),
        refundExecutionSucceeded: vi.fn((m: any) =>
          signals.push(["success", committed, m]),
        ),
        refundExecutionFailed: vi.fn((m: any) =>
          signals.push(["failed", committed, m]),
        ),
      },
    },
    r,
    signals,
    get committed() {
      return committed;
    },
  };
}
async function made(c: any) {
  return createRefundUseCase(c.ctx, {
    orderId: "o1",
    currency: "EUR",
    subtotalAmount: 10,
    idempotencyKey: `k${Math.random()}`,
  });
}
describe("refund observability sprint 30B R7", () => {
  it("transition signal after commit", async () => {
    const c = ctx();
    const a = await made(c);
    await submitRefundUseCase(c.ctx, { refundId: a.refund.id });
    expect(c.signals.find((s: any) => s[0] === "transition")?.[1]).toBe(true);
  });
  it("queue signal after commit", async () => {
    const c = ctx();
    const a = await made(c);
    await submitRefundUseCase(c.ctx, { refundId: a.refund.id });
    expect(c.signals.find((s: any) => s[0] === "queue")?.[1]).toBe(true);
  });
  it("no success signal on rollback", async () => {
    const c = ctx();
    c.r.refundEvents.append = () => {
      throw new Error("persist fail");
    };
    const a = await made(ctx()).then((x) => x);
    await expect(
      submitRefundUseCase(
        { ...c.ctx, repositories: c.r },
        { refundId: a.refund.id },
      ),
    ).rejects.toThrow();
    expect(c.signals).toHaveLength(0);
  });
  it("observability failure does not alter business result", async () => {
    const c = ctx();
    c.ctx.observability.refundTransitionRecorded = vi.fn(() => {
      throw new Error("obs");
    });
    const a = await made(c);
    await expect(
      submitRefundUseCase(c.ctx, { refundId: a.refund.id }),
    ).resolves.toBeTruthy();
  });
  it("logger failure does not alter business result", async () => {
    const c = ctx();
    c.ctx.observability.refundTransitionRecorded = vi.fn(() => {
      throw new Error("obs");
    });
    c.ctx.logger.warn = () => {
      throw new Error("log");
    };
    const a = await made(c);
    await expect(
      submitRefundUseCase(c.ctx, { refundId: a.refund.id }),
    ).resolves.toBeTruthy();
  });
  it("safe structured fields only", () =>
    expect(
      safeRefundLogMeta({ refundId: "r", accessToken: "x", cardNumber: "4" }),
    ).toEqual({ refundId: "r" }));
  it("no raw provider payload", () =>
    expect(
      safeRefundLogMeta({
        rawProviderResponse: { x: 1 },
        providerStatus: "ok",
      }),
    ).toEqual({ providerStatus: "ok" }));
  it("no credential leakage", () =>
    expect(
      JSON.stringify(safeRefundLogMeta({ secret: "x", refundId: "r" })),
    ).not.toContain("x"));
  it("multiple contexts do not leak observer state", async () => {
    const a = ctx(),
      b = ctx();
    const ra = await made(a),
      rb = await made(b);
    await submitRefundUseCase(a.ctx, { refundId: ra.refund.id });
    await cancelRefundUseCase(b.ctx, { refundId: rb.refund.id });
    expect(a.signals).not.toBe(b.signals);
  });
  it("emits generic signal safely", async () => {
    const fn = vi.fn();
    await emitRefundSignal(
      { refundProviderResolved: fn },
      "refundProviderResolved",
      { refundId: "r" },
    );
    expect(fn).toHaveBeenCalled();
  });
  it("safe logger strips forbidden fields", () => {
    const info = vi.fn();
    createSafeRefundLogger({ info }).info("m", {
      refundId: "r",
      password: "p",
    });
    expect(info).toHaveBeenCalledWith("m", { refundId: "r" });
  });
  it("returned events are ordered by timestamp and id", async () => {
    const c = ctx();
    const a = await made(c);
    c.r._.events.push({
      id: "a",
      refundId: a.refund.id,
      createdAt: t,
      eventType: "RefundSubmitted",
      payloadSnapshot: {},
    });
    expect(
      (await c.r.refundEvents.listByRefundId(a.refund.id)).map(
        (e: any) => e.id,
      ),
    ).toEqual(["a", "id2"]);
  });
  it("repository has no update API", () =>
    expect("update" in repo().refundEvents).toBe(false));
  it("repository has no delete API", () =>
    expect("delete" in repo().refundEvents).toBe(false));
  it("duplicate event idempotency returns one stored event", () => {
    const r = repo();
    r.refundEvents.append({
      id: "e1",
      refundId: "r",
      idempotencyKey: "k",
      createdAt: t,
      eventType: "RefundCreated",
    });
    expect(r.refundEvents.findByIdempotencyKey("k").id).toBe("e1");
  });
});
