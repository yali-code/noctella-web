import { describe, expect, it } from "vitest";
import { auditRefundTransactionSafety, resolveRefundAuditBase } from "../src/scripts/refundTransactionAudit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(new URL("../src/use-cases/refund/useCases.ts", import.meta.url), "utf8");
const serviceContext = readFileSync(new URL("../src/services/refundServiceContext.ts", import.meta.url), "utf8");
const minimalProviders = "export interface RefundExecutionRequest { refundId:string }";
const fixtures = { useCases: source, serviceContext, providers: minimalProviders };
const mustContain = [
  ["create refund UnitOfWork", "createRefundUseCase", "ctx.unitOfWork.run"],
  ["submit transition UnitOfWork", "transition", "ctx.unitOfWork.run"],
  ["execute claim UnitOfWork", "RefundEvents.Processing", "ctx.unitOfWork.run"],
  ["execute success UnitOfWork", "RefundStatuses.Succeeded", "ctx.unitOfWork.run"],
  ["execute failure UnitOfWork", "RefundStatuses.Failed", "ctx.unitOfWork.run"],
  ["create refund row", "refunds.create", "createRefundUseCase"],
  ["create allocation rows", "refundItems.createMany", "createRefundUseCase"],
  ["submit attempt create", "refundAttempts.create", "RefundEvents.Submitted"],
  ["retry attempt create", "refundAttempts.create", "RefundEvents.RetryRequested"],
  ["claim attempt processing", "refundAttempts.update", "status:\"processing\""],
  ["success attempt update", "refundAttempts.update", "status:\"succeeded\""],
  ["failure attempt update", "refundAttempts.update", "status:\"failed\""],
  ["event append helper", "refundEvents.append", "appendOnce"],
  ["idempotent event key", "findByIdempotencyKey", "appendOnce"],
  ["create idempotency replay", "findByIdempotencyKey(input.idempotencyKey)", "IDEMPOTENCY_CONFLICT"],
  ["same payload replay", "eqPayload(input, existing)", "return detail(repos, existing)"],
  ["optimistic update", "updateWithVersion", "STALE_REFUND_VERSION"],
  ["submit enqueue after transition", "if(enqueue)", "enqueueRefundExecution"],
  ["cancel queue after transition", "cancelRefundExecution", "return out"],
  ["provider request after claim", "const req=", "port.executeRefund(req)"],
  ["provider normalization", "toProviderResult", "normalizeRefundProviderError"],
  ["duplicate success replay", "externalRefundId", "return getRefundUseCase"],
  ["terminal guard", "RefundStatuses.Succeeded", "externalRefundId"],
  ["stale claim rejected", "Only pending refunds can execute", "STALE_REFUND_VERSION"],
  ["success event atomic", "RefundEvents.Succeeded", "refundAttempts.update"],
  ["failure event atomic", "RefundEvents.Failed", "refundAttempts.update"],
  ["runtime context UnitOfWork", "new SqliteUnitOfWork(db)", "createRefundApplicationContext"],
  ["provider outside UnitOfWork", "port.executeRefund(req)", "await ctx.unitOfWork.run"],
  ["queue warning async", "logger.warn", "enqueue failed"],
  ["safe errors", "safeMsg", "[redacted]"],
] as const;

describe("refund transaction completion Sprint 30B-R6", () => {
  it("production transaction audit passes", () => expect(auditRefundTransactionSafety()).toBe(true));
  it("I: resolves the apps/api base directory from both POSIX and Windows style cwd paths", () => {
    // Already-inside-apps/api cwd must be returned verbatim (no separator mixing) on either style -
    // this is the exact scenario the old endsWith("apps/api") check silently failed on Windows.
    expect(resolveRefundAuditBase("/home/runner/work/noctella-web/apps/api")).toBe("/home/runner/work/noctella-web/apps/api");
    expect(resolveRefundAuditBase("C:\\Users\\Admin\\noctella-web\\apps\\api")).toBe("C:\\Users\\Admin\\noctella-web\\apps\\api");
    // A repo-root cwd falls back to joining "apps/api" using the host platform's own separator.
    expect(resolveRefundAuditBase("/home/runner/work/noctella-web")).toBe(join("/home/runner/work/noctella-web", "apps", "api"));
    expect(resolveRefundAuditBase("C:\\Users\\Admin\\noctella-web")).toBe(join("C:\\Users\\Admin\\noctella-web", "apps", "api"));
  });
  it.each(mustContain)("verifies %s", (_name, a, b) => { expect(source + serviceContext).toContain(a); expect(source + serviceContext).toContain(b); });
  it.each([
    ["provider inside transaction", { ...fixtures, useCases: source + "\nctx.unitOfWork.run(()=>port.executeRefund(req));" }, /provider inside transaction/],
    ["manual commit", { ...fixtures, useCases: source + "\n.commit()" }, /manual transaction/],
    ["manual rollback", { ...fixtures, useCases: source + "\n.rollback()" }, /manual transaction/],
    ["raw begin", { ...fixtures, useCases: source + "\nBEGIN" }, /manual transaction/],
    ["raw transaction", { ...fixtures, useCases: source + "\ntransaction(" }, /manual transaction/],
    ["missing updateWithVersion", { ...fixtures, useCases: source.replaceAll("updateWithVersion", "updateDirect") }, /missing updateWithVersion/],
    ["provider UnitOfWork", { ...fixtures, providers: "UnitOfWork" }, /provider can see/],
    ["provider repository", { ...fixtures, providers: "Repository" }, /provider can see/],
    ["provider db", { ...fixtures, providers: "DbClient" }, /provider can see/],
    ["service context missing UOW", { ...fixtures, serviceContext: serviceContext.replace("new SqliteUnitOfWork(db)", "noUnitOfWork") }, /runtime refund context/],
    ["success missing event", { ...fixtures, useCases: source.replace("RefundEvents.Succeeded", "RefundEvents.Noop") }, /success status/],
    ["failure missing event", { ...fixtures, useCases: source.replace(/(const providerFailure = normalizeRefundProviderError\(e\)[\s\S]*?)RefundEvents\.Failed/, "$1RefundEvents.Noop") }, /failure status/],
    ["enqueue in transaction", { ...fixtures, useCases: source.replace("if(enqueue) {", "ctx.unitOfWork.run(()=>ctx.enqueue.enqueueRefundExecution(input.refundId)); if(enqueue) {") }, /queue enqueue before commit/],
    ["cancel in transaction", { ...fixtures, useCases: source.replace("try{ await ctx.enqueue.cancelRefundExecution", "ctx.unitOfWork.run(()=>ctx.enqueue.cancelRefundExecution(input.refundId)); try{ await ctx.enqueue.cancelRefundExecution") }, /queue cancellation before commit/],
    ["provider execution missing", { ...fixtures, useCases: source.replace("port.executeRefund(req)", "port.noop(req)") }, /provider execution/],
    ["success atomicity broken", { ...fixtures, useCases: source.replace("status:\"succeeded\",externalRefundId", "status:\"unknown\",externalRefundId") }, /success status/],
    ["failure atomicity broken", { ...fixtures, useCases: source.replace("status:\"failed\",errorCode", "status:\"unknown\",errorCode") }, /failure status/],
  ] as const)("rejects %s", (_name, bad, pattern) => expect(() => auditRefundTransactionSafety(bad)).toThrow(pattern));
});
