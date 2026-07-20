import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { auditRefundApplicationContextSource, runRefundApplicationContextAudit } from "../src/scripts/refundApplicationContextAudit";
import { createRefundApplicationContext, type ApprovedReturnDto, type MarketplaceRefundPort, type OrderRefundReadPort, type PaymentRefundPort, type RefundApplicationContext, type RefundOrderDto, type RefundProviderRequest, type ReturnRefundReadPort } from "../src/services/refundApplicationContext";

function deps(): RefundApplicationContext {
  const repositories = { refunds: {}, refundItems: {}, refundAttempts: {}, refundEvents: {} } as RefundApplicationContext["repositories"];
  return {
    unitOfWork: { run: vi.fn(async (work) => work({ repositories: {} as never })) },
    repositories,
    readPorts: {
      orders: { findRefundOrder: vi.fn(() => ({ id: "o1", currency: "EUR" })), findRefundItems: vi.fn(() => []) },
      returns: { findApprovedReturn: vi.fn(() => ({ id: "r1", orderId: "o1", status: "approved", approvedAt: "now" })), findApprovedItems: vi.fn(() => []) },
      marketplaceConnections: { findConnection: vi.fn(() => null), resolveProvider: vi.fn(() => "market") },
      payments: { findPayment: vi.fn(() => null), findRemainingRefundAmount: vi.fn(() => 10) },
    },
    providerPorts: { resolveMarketplaceProvider: vi.fn(), resolvePaymentProvider: vi.fn() },
    clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00.000Z")) },
    idGenerator: { newId: vi.fn(() => "id-1") },
    enqueue: { enqueueRefundExecution: vi.fn(), cancelRefundExecution: vi.fn() },
    logger: { info: vi.fn(), error: vi.fn() },
    errorNormalizer: { normalize: vi.fn((error) => ({ code: "ERR", message: String(error), cause: error })) },
  };
}

describe("Sprint 30B-R2 Refund application context", () => {
  test("factory creation", () => expect(createRefundApplicationContext(deps())).toBeTruthy());
  test("dependency injection keeps unit of work", () => { const d = deps(); expect(createRefundApplicationContext(d).unitOfWork).toBe(d.unitOfWork); });
  test("repository exposure", () => { const d = deps(); expect(createRefundApplicationContext(d).repositories).toBe(d.repositories); });
  test("order read port exposure", () => expect(createRefundApplicationContext(deps()).readPorts.orders.findRefundOrder("o1")).toMatchObject({ id: "o1" }));
  test("return read port exposure", () => expect(createRefundApplicationContext(deps()).readPorts.returns.findApprovedReturn("r1")).toMatchObject({ id: "r1" }));
  test("marketplace connection read port exposure", () => expect(createRefundApplicationContext(deps()).readPorts.marketplaceConnections.resolveProvider({ id: "c1", marketplace: "m", providerKey: "p" })).toBe("market"));
  test("payment read port exposure", () => expect(createRefundApplicationContext(deps()).readPorts.payments.findRemainingRefundAmount("p1")).toBe(10));
  test("clock exposure", () => expect(createRefundApplicationContext(deps()).clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z"));
  test("UUID exposure", () => expect(createRefundApplicationContext(deps()).idGenerator.newId()).toBe("id-1"));
  test("enqueue exposure", () => { const c = createRefundApplicationContext(deps()); c.enqueue.enqueueRefundExecution("r1"); expect(c.enqueue.enqueueRefundExecution).toHaveBeenCalledWith("r1"); });
  test("logger exposure", () => { const c = createRefundApplicationContext(deps()); c.logger.info?.("created"); expect(c.logger.info).toHaveBeenCalledWith("created"); });
  test("immutability", () => expect(Object.isFrozen(createRefundApplicationContext(deps()))).toBe(true));
  test("missing dependency", () => expect(() => createRefundApplicationContext({ ...deps(), clock: undefined as never })).toThrow("REFUND_APPLICATION_CONTEXT_MISSING_clock"));
  test("optional logger methods", () => expect(createRefundApplicationContext({ ...deps(), logger: {} }).logger).toEqual({}));
  test("registry exposure", () => { const c = createRefundApplicationContext(deps()); expect(c.providerPorts).toHaveProperty("resolveMarketplaceProvider"); expect(c.providerPorts).toHaveProperty("resolvePaymentProvider"); });
  test("DTO typing", () => { const dto: RefundOrderDto = { id: "o1", currency: "EUR", totalAmount: 12 }; expect(dto.totalAmount).toBe(12); });
  test("provider interface typing", async () => { const port: MarketplaceRefundPort = { executeRefund: (r: RefundProviderRequest) => ({ providerRefundId: r.refundId, status: "ok" }), cancelRefund: (id) => ({ providerRefundId: id, status: "cancelled" }), getRefundStatus: (id) => ({ providerRefundId: id, status: "ok" }) }; expect((await port.executeRefund({ refundId: "r1", orderId: "o1", amount: 1, currency: "EUR", idempotencyKey: "k" })).status).toBe("ok"); });
  test("payment provider interface typing", async () => { const port: PaymentRefundPort = { executeRefund: (r) => ({ providerRefundId: r.refundId, status: "ok" }), cancelRefund: (id) => ({ providerRefundId: id, status: "cancelled" }), getRefundStatus: (id) => ({ providerRefundId: id, status: "ok" }) }; expect((await port.cancelRefund("r1")).status).toBe("cancelled"); });
  test("read port typing", () => { const port: OrderRefundReadPort = { findRefundOrder: () => ({ id: "o1", currency: "EUR" }), findRefundItems: () => [{ id: "i1", orderId: "o1", quantity: 1, refundableAmount: 2, currency: "EUR" }] }; expect(port.findRefundItems("o1")).toHaveLength(1); });
  test("return read port DTO typing", () => { const port: ReturnRefundReadPort = { findApprovedReturn: (): ApprovedReturnDto => ({ id: "r1", orderId: "o1", status: "approved", approvedAt: "now" }), findApprovedItems: () => [] }; expect(port.findApprovedReturn("r1")).toMatchObject({ status: "approved" }); });
  test("error normalizer", () => expect(createRefundApplicationContext(deps()).errorNormalizer.normalize(new Error("x"))).toMatchObject({ code: "ERR" }));
  test("audit success", () => expect(runRefundApplicationContextAudit().status).toBe("PASS"));
  test("audit success after changing to a temporary working directory", () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "refund-context-audit-"));
    try { process.chdir(temporaryDirectory); expect(runRefundApplicationContextAudit().status).toBe("PASS"); }
    finally { process.chdir(originalDirectory); rmSync(temporaryDirectory, { recursive: true, force: true }); }
  });
  test("audit rejects forbidden source", () => expect(auditRefundApplicationContextSource("import type { DbClient } from '../db/client'; fetch('x')").status).toBe("FAIL"));
  test("factory stability", () => { const d = deps(); expect(createRefundApplicationContext(d)).toEqual(createRefundApplicationContext(d)); });
  test("multiple context creation", () => expect(createRefundApplicationContext(deps())).not.toBe(createRefundApplicationContext(deps()))); 
  test("context isolation", () => { const a = createRefundApplicationContext(deps()); const b = createRefundApplicationContext(deps()); expect(a.repositories).not.toBe(b.repositories); });
});
