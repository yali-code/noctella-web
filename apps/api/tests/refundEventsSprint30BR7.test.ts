import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createRefundEvent, RefundEventNames } from "../src/domain/refund";
import { auditRefundEventObservability } from "../src/scripts/refundEventObservabilityAudit";
const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
const idGenerator = { newId: () => "event-1" };
const ev = (name: any, payload: any = {}) =>
  createRefundEvent({
    eventName: name,
    refundId: "r1",
    orderId: "o1",
    returnRequestId: "ret1",
    refundStatus: "pending",
    previousStatus: "draft",
    actorId: "actor",
    source: "test",
    correlationId: "corr",
    causationId: "cause",
    idempotencyKey: `k:${name}`,
    payload,
    clock,
    idGenerator,
  });
describe("refund events sprint 30B R7", () => {
  it("defines exact canonical event names", () =>
    expect(Object.values(RefundEventNames)).toEqual([
      "RefundCreated",
      "RefundSubmitted",
      "RefundProcessing",
      "RefundSucceeded",
      "RefundFailed",
      "RefundRetryRequested",
      "RefundCancelled",
    ]));
  it("creates RefundCreated payload", () =>
    expect(
      ev(RefundEventNames.Created, {
        amount: 10,
        currency: "EUR",
        allocationCount: 2,
        creationSource: "api",
      }).payload,
    ).toMatchObject({ amount: 10, currency: "EUR", allocationCount: 2 }));
  it("creates RefundSubmitted payload", () =>
    expect(
      ev(RefundEventNames.Submitted, { attemptNumber: 1, queueRequested: true })
        .payload,
    ).toMatchObject({ attemptNumber: 1, queueRequested: true }));
  it("creates RefundProcessing payload", () =>
    expect(
      ev(RefundEventNames.Processing, {
        attemptNumber: 1,
        providerType: "payment",
        providerIdentifier: "mock",
        executionSource: "worker",
      }).payload,
    ).toMatchObject({ providerType: "payment" }));
  it("creates RefundSucceeded payload", () =>
    expect(
      ev(RefundEventNames.Succeeded, {
        externalRefundReference: "ext",
        providerStatus: "succeeded",
        processedAt: "now",
      }).payload,
    ).toMatchObject({ externalRefundReference: "ext" }));
  it("creates RefundFailed payload", () =>
    expect(
      ev(RefundEventNames.Failed, {
        errorCode: "E",
        message: "boom",
        retryable: true,
        attemptNumber: 1,
      }).payload,
    ).toMatchObject({ errorCode: "E", retryable: true }));
  it("creates RefundRetryRequested payload", () =>
    expect(
      ev(RefundEventNames.RetryRequested, {
        nextAttemptNumber: 2,
        reason: "safe",
      }).payload,
    ).toMatchObject({ nextAttemptNumber: 2 }));
  it("creates RefundCancelled payload", () =>
    expect(
      ev(RefundEventNames.Cancelled, {
        cancellationSource: "api",
        reason: "safe",
      }).payload,
    ).toMatchObject({ cancellationSource: "api" }));
  it("uses IdGenerator", () =>
    expect(ev(RefundEventNames.Created).eventId).toBe("event-1"));
  it("uses Clock timestamp", () =>
    expect(ev(RefundEventNames.Created).occurredAt).toBe(
      "2026-01-01T00:00:00.000Z",
    ));
  it("freezes envelope", () =>
    expect(Object.isFrozen(ev(RefundEventNames.Created))).toBe(true));
  it("freezes payload", () =>
    expect(Object.isFrozen(ev(RefundEventNames.Created).payload)).toBe(true));
  it("strips credential fields", () =>
    expect(
      ev(RefundEventNames.Failed, { accessToken: "secret", message: "ok" })
        .payload,
    ).not.toHaveProperty("accessToken"));
  it("strips raw provider response fields", () =>
    expect(
      ev(RefundEventNames.Succeeded, {
        rawProviderResponse: { secret: true },
        externalRefundReference: "x",
      }).payload,
    ).not.toHaveProperty("rawProviderResponse"));
  it("bounds error messages", () =>
    expect(
      String(
        ev(RefundEventNames.Failed, { message: "x".repeat(500) }).payload
          .message,
      ).length,
    ).toBeLessThanOrEqual(240));
  it("preserves safe metadata", () =>
    expect(ev(RefundEventNames.Created).actorId).toBe("actor"));
  it("preserves correlation ID", () =>
    expect(ev(RefundEventNames.Created).correlationId).toBe("corr"));
  it("preserves causation ID", () =>
    expect(ev(RefundEventNames.Created).causationId).toBe("cause"));
  it("rejects unknown event name", () =>
    expect(() => ev("RefundNope")).toThrow("INVALID_REFUND_EVENT_NAME"));
  it("requires refund ID", () =>
    expect(() =>
      createRefundEvent({
        eventName: RefundEventNames.Created,
        refundId: "",
        payload: {},
        clock,
        idGenerator,
      }),
    ).toThrow("REFUND_EVENT_REFUND_ID_REQUIRED"));
  it("redacts bearer tokens in values", () =>
    expect(
      String(
        ev(RefundEventNames.Failed, { message: "Bearer abc" }).payload.message,
      ),
    ).toContain("[redacted]"));
  it("does not expose card fields", () =>
    expect(
      ev(RefundEventNames.Created, { cardNumber: "4111", amount: 1 }).payload,
    ).not.toHaveProperty("cardNumber"));
  it("production event observability audit passes", () =>
    expect(auditRefundEventObservability().pass).toBe(true));
  it("production audit passes from the repository root", () => {
    const originalDirectory = process.cwd();
    try { process.chdir(resolve(__dirname, "../../..")); expect(auditRefundEventObservability().pass).toBe(true); }
    finally { process.chdir(originalDirectory); }
  });
  it("audit rejects DB fixture", () =>
    expect(
      auditRefundEventObservability({
        events: "import { db } from '../db/schema';",
      }).pass,
    ).toBe(false));
  it("audit rejects SDK fixture", () =>
    expect(
      auditRefundEventObservability({ observability: "fetch('x')" }).pass,
    ).toBe(false));
  it("audit rejects HTTP fixture", () =>
    expect(
      auditRefundEventObservability({ observability: "axios.post('/x')" }).pass,
    ).toBe(false));
  it("audit rejects credential fixture", () =>
    expect(
      auditRefundEventObservability({ events: "const accessToken = 'x'" }).pass,
    ).toBe(false));
  it("audit rejects mutation fixture", () =>
    expect(
      auditRefundEventObservability({ events: "refundEvents.update()" }).pass,
    ).toBe(false));
  it("audit rejects observability-inside-transaction fixture", () =>
    expect(
      auditRefundEventObservability({
        useCases: "unitOfWork.run(()=>refundTransitionRecorded())",
      }).pass,
    ).toBe(false));
});
