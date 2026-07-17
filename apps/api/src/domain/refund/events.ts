import type {
  Clock,
  IdGenerator,
} from "../../services/refundApplicationContext";

export const RefundEventNames = Object.freeze({
  Created: "RefundCreated",
  Submitted: "RefundSubmitted",
  Processing: "RefundProcessing",
  Succeeded: "RefundSucceeded",
  Failed: "RefundFailed",
  RetryRequested: "RefundRetryRequested",
  Cancelled: "RefundCancelled",
} as const);
export type RefundEventName =
  (typeof RefundEventNames)[keyof typeof RefundEventNames];
export type RefundActorType =
  | "system"
  | "merchant"
  | "customer"
  | "provider"
  | "admin"
  | "unknown";
export type SafeRefundProviderType = "marketplace" | "payment" | "unknown";
export type RefundCreatedPayload = Readonly<{
  amount: number;
  currency: string;
  allocationCount: number;
  creationSource?: string | null;
}>;
export type RefundSubmittedPayload = Readonly<{
  attemptNumber: number;
  queueRequested: boolean;
}>;
export type RefundProcessingPayload = Readonly<{
  attemptNumber: number;
  providerType?: SafeRefundProviderType | null;
  providerIdentifier?: string | null;
  executionSource?: string | null;
}>;
export type RefundSucceededPayload = Readonly<{
  externalRefundReference?: string | null;
  providerStatus?: string | null;
  processedAt?: string | null;
}>;
export type RefundFailedPayload = Readonly<{
  errorCode: string;
  message: string;
  retryable: boolean;
  attemptNumber: number;
}>;
export type RefundRetryRequestedPayload = Readonly<{
  nextAttemptNumber: number;
  reason?: string | null;
}>;
export type RefundCancelledPayload = Readonly<{
  cancellationSource?: string | null;
  reason?: string | null;
}>;
export type RefundEventPayloadByName = {
  RefundCreated: RefundCreatedPayload;
  RefundSubmitted: RefundSubmittedPayload;
  RefundProcessing: RefundProcessingPayload;
  RefundSucceeded: RefundSucceededPayload;
  RefundFailed: RefundFailedPayload;
  RefundRetryRequested: RefundRetryRequestedPayload;
  RefundCancelled: RefundCancelledPayload;
};
export type RefundEventPayload<N extends RefundEventName = RefundEventName> =
  RefundEventPayloadByName[N];
export type RefundEventEnvelope<N extends RefundEventName = RefundEventName> =
  Readonly<{
    eventId: string;
    refundId: string;
    orderId?: string | null;
    returnRequestId?: string | null;
    eventName: N;
    refundStatus?: string | null;
    previousStatus?: string | null;
    occurredAt: string;
    actorType?: RefundActorType | null;
    actorId?: string | null;
    source?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    idempotencyKey?: string | null;
    payload: Readonly<RefundEventPayload<N>>;
  }>;
const forbidden =
  /(authorization|access[_-]?token|refresh[_-]?token|password|secret|credential|raw|card|pan|cvv|paymentInstrument|provider[_-]?response|http[_-]?response)/i;
const clean = (v: unknown): unknown =>
  typeof v === "string"
    ? v
        .replace(
          /Bearer\s+\S+|access[_-]?token\s*[:=]?\s*\S+|refresh[_-]?token\s*[:=]?\s*\S+|secret\s*[:=]?\s*\S+|password\s*[:=]?\s*\S+/gi,
          "[redacted]",
        )
        .slice(0, 240)
    : v;
function sanitizePayload<N extends RefundEventName>(
  name: N,
  payload: Record<string, unknown>,
): RefundEventPayload<N> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (forbidden.test(k)) continue;
    out[k] = clean(v);
  }
  if (name === RefundEventNames.Failed && typeof out.message === "string")
    out.message = out.message.slice(0, 240);
  return Object.freeze(out) as RefundEventPayload<N>;
}
export function createRefundEvent<N extends RefundEventName>(input: {
  eventName: N;
  refundId: string;
  orderId?: string | null;
  returnRequestId?: string | null;
  refundStatus?: string | null;
  previousStatus?: string | null;
  actorType?: RefundActorType | null;
  actorId?: string | null;
  source?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  clock: Clock;
  idGenerator: IdGenerator;
}): RefundEventEnvelope<N> {
  if (!Object.values(RefundEventNames).includes(input.eventName))
    throw new Error("INVALID_REFUND_EVENT_NAME");
  if (!input.refundId) throw new Error("REFUND_EVENT_REFUND_ID_REQUIRED");
  return Object.freeze({
    eventId: input.idGenerator.newId(),
    refundId: input.refundId,
    orderId: input.orderId ?? null,
    returnRequestId: input.returnRequestId ?? null,
    eventName: input.eventName,
    refundStatus: input.refundStatus ?? null,
    previousStatus: input.previousStatus ?? null,
    occurredAt: input.clock.now().toISOString(),
    actorType: input.actorType ?? "unknown",
    actorId: input.actorId ?? null,
    source: input.source ?? "refund-use-case",
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: sanitizePayload(input.eventName, input.payload),
  });
}
export const cloneRefundEventEnvelope = <N extends RefundEventName>(
  e: RefundEventEnvelope<N>,
): RefundEventEnvelope<N> =>
  Object.freeze({
    ...e,
    payload: Object.freeze({
      ...(e.payload as object),
    }) as RefundEventPayload<N>,
  });
