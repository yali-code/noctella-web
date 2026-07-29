import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { createReturnRefundSqliteHarness, deterministicClock } from "./helpers/returnRefundHarness";
import { createRefundRepositoriesForDb } from "../src/repositories/refund/factory";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createRefundApplicationContext } from "../src/services/refundApplicationContext";
import { createRefundUseCase, executeRefundUseCase, submitRefundUseCase } from "../src/use-cases/refund";

/**
 * Refund succeeded-lifecycle correction: createRefundUseCase previously accepted an arbitrary
 * input.status but unconditionally hardcoded submittedAt/succeededAt to null, so a refund created
 * directly as Succeeded (the only production path: refundsCompatibility.createRefund, behind
 * POST /orders/:orderId/refunds) ended up with status "succeeded" and both lifecycle timestamps
 * null - and refundsCompatibility posted its SuccessfulRefund finance entry as a second,
 * non-atomic step outside the use case's own transaction. Uses a real in-memory SQLite db + the
 * real SqliteUnitOfWork/refund repositories (matching refundFinanceLedgerIntegritySprint56B.test.ts's
 * harness) so the transaction-scoped repositories.db the fix now writes through is genuine.
 */
function buildContext(h: ReturnType<typeof createReturnRefundSqliteHarness>) {
  return createRefundApplicationContext({
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
        executeRefund: async (req: any) => ({ providerRefundId: `ext-${req.refundId}`, status: "succeeded" }),
        cancelRefund: async (id: string) => ({ providerRefundId: id, status: "cancelled" }),
        getRefundStatus: async (id: string) => ({ providerRefundId: id, status: "ok" }),
      }),
      resolvePaymentProvider: async () => { throw new Error("REFUND_PAYMENT_PROVIDER_NOT_CONFIGURED"); },
    } as any,
    clock: { now: () => deterministicClock.now() },
    idGenerator: { newId: () => randomUUID() },
    enqueue: { enqueueRefundExecution: () => undefined, cancelRefundExecution: () => undefined },
    logger: { warn: () => {} },
    errorNormalizer: { normalize: (e: any) => ({ code: e?.code ?? "Provider", message: e?.message ?? "provider", cause: e }) },
  });
}
async function ledgerEntries(h: ReturnType<typeof createReturnRefundSqliteHarness>, refundId: string) {
  return h.db.select().from(schema.financeEntries).where(eq(schema.financeEntries.refundId, refundId));
}
async function allRefunds(h: ReturnType<typeof createReturnRefundSqliteHarness>) {
  return h.db.select().from(schema.refunds);
}
async function allFinanceEntries(h: ReturnType<typeof createReturnRefundSqliteHarness>) {
  return h.db.select().from(schema.financeEntries);
}

describe("refund succeeded-lifecycle correction", () => {
  it("Draft creation leaves submittedAt/succeededAt/failedAt null and posts no SuccessfulRefund finance entry", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, idempotencyKey: "draft-1" });
      expect(created.refund.status).toBe("draft");
      expect(created.refund.submittedAt).toBeNull();
      expect(created.refund.succeededAt).toBeNull();
      expect(created.refund.failedAt).toBeNull();
      expect(await ledgerEntries(h, created.refund.id)).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("Succeeded creation atomically populates submittedAt and succeededAt (equal to each other) and posts exactly one SuccessfulRefund finance entry referencing the refund and order, snapshotting the populated timestamps", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, status: "succeeded", idempotencyKey: "succ-1" });
      expect(created.refund.status).toBe("succeeded");
      expect(created.refund.submittedAt).toBeTruthy();
      expect(created.refund.succeededAt).toBeTruthy();
      expect(created.refund.submittedAt).toBe(created.refund.succeededAt);
      expect(created.refund.failedAt).toBeNull();
      const entries = await ledgerEntries(h, created.refund.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe("SuccessfulRefund");
      expect(entries[0].refundId).toBe(created.refund.id);
      expect(entries[0].orderId).toBe("o1");
      expect(entries[0].amount).toBe(120);
      expect(entries[0].idempotencyKey).toBe(`successful-refund:${created.refund.id}`);
      const snapshot = JSON.parse(entries[0].sourceSnapshot);
      expect(snapshot.submittedAt).toBe(created.refund.submittedAt);
      expect(snapshot.succeededAt).toBe(created.refund.succeededAt);
    } finally { h.cleanup(); }
  });

  it.each(["pending", "submitted", "processing", "failed", "cancelled", "bogus-status"])(
    "rejects direct creation with status \"%s\", writing no refund and no finance entry",
    async (status) => {
      const h = createReturnRefundSqliteHarness();
      try {
        const ctx = buildContext(h);
        await expect(
          createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, status, idempotencyKey: `bad-${status}` } as any),
        ).rejects.toMatchObject({ code: "INVALID_REFUND_CREATION_STATUS" });
        expect(await allRefunds(h)).toHaveLength(0);
        expect(await allFinanceEntries(h)).toHaveLength(0);
      } finally { h.cleanup(); }
    },
  );

  it("full-refund idempotent replay: after a Succeeded refund for the entire 120 EUR order consumes the whole refundable balance, replaying the exact same request and idempotency key still returns the original refund rather than being rejected by amount validation", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      const request = { orderId: "o1", currency: "EUR", subtotalAmount: 120, status: "succeeded" as const, idempotencyKey: "full-replay-1" };
      const first = await createRefundUseCase(ctx, request);
      expect(first.refund.totalAmount).toBe(120);
      // The whole order is now consumed - a genuinely new request for any further amount would be
      // rejected (proven separately below); the replay of THIS SAME request must not be.
      const { calculateMaximumRefundUseCase } = await import("../src/use-cases/refund");
      expect((await calculateMaximumRefundUseCase(ctx, { orderId: "o1" })).refundableAmount).toBe(0);

      const replay = await createRefundUseCase(ctx, request);
      expect(replay.refund.id).toBe(first.refund.id);
      expect(replay.refund.submittedAt).toBe(first.refund.submittedAt);
      expect(replay.refund.succeededAt).toBe(first.refund.succeededAt);
      expect(await allRefunds(h)).toHaveLength(1);
      expect(await ledgerEntries(h, first.refund.id)).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("idempotency conflict is detected before amount validation: the same key reused with a different (larger) amount still throws IDEMPOTENCY_CONFLICT, not AMOUNT_EXCEEDS_MAXIMUM, even though no refundable balance remains", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, status: "succeeded", idempotencyKey: "conflict-1" });
      // subtotalAmount 130 exceeds the order total entirely (and the remaining refundable balance
      // is already 0) - if validation ran first, this would fail as AMOUNT_EXCEEDS_MAXIMUM; because
      // the idempotency-key lookup now runs first, the payload mismatch is caught before that.
      await expect(
        createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 130, status: "succeeded", idempotencyKey: "conflict-1" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await allRefunds(h)).toHaveLength(1);
      expect(await allFinanceEntries(h)).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("does not weaken validation for a genuinely new request: once the full order is refunded, a different idempotency key requesting further amount is still rejected as AMOUNT_EXCEEDS_MAXIMUM", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, status: "succeeded", idempotencyKey: "consumed-1" });
      await expect(
        createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 10, status: "succeeded", idempotencyKey: "genuinely-new-1" }),
      ).rejects.toMatchObject({ code: "AMOUNT_EXCEEDS_MAXIMUM" });
      expect(await allRefunds(h)).toHaveLength(1);
      expect(await allFinanceEntries(h)).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("atomicity: a finance-posting failure rolls back the Succeeded refund creation entirely - never a Succeeded refund without its finance entry", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      (h.sqlite as any).exec("CREATE TRIGGER fail_refund_finance_entry BEFORE INSERT ON finance_entries BEGIN SELECT RAISE(ABORT, 'finance entry insert failed'); END");
      let caught: any;
      try {
        await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, status: "succeeded", idempotencyKey: "atomic-1" });
      } catch (e) {
        caught = e;
      } finally {
        (h.sqlite as any).exec("DROP TRIGGER fail_refund_finance_entry");
      }
      expect(caught).toBeTruthy();
      expect(String(caught?.message ?? "")).toContain("finance entry insert failed");
      expect(await allRefunds(h)).toHaveLength(0);
      expect(await allFinanceEntries(h)).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("executeRefundUseCase remains unchanged: the async submit -> execute path still populates succeededAt and still creates exactly one SuccessfulRefund finance entry", async () => {
    const h = createReturnRefundSqliteHarness();
    try {
      const ctx = buildContext(h);
      const created = await createRefundUseCase(ctx, { orderId: "o1", currency: "EUR", subtotalAmount: 120, channel: "eBay", idempotencyKey: "exec-1" });
      expect(created.refund.status).toBe("draft");
      expect(created.refund.succeededAt).toBeNull();
      await submitRefundUseCase(ctx, { refundId: created.refund.id });
      const result = await executeRefundUseCase(ctx, { refundId: created.refund.id });
      expect(result.refund.status).toBe("succeeded");
      expect(result.refund.succeededAt).toBeTruthy();
      const entries = await ledgerEntries(h, created.refund.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType).toBe("SuccessfulRefund");
    } finally { h.cleanup(); }
  });
});
