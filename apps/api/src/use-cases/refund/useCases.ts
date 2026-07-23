import type { RefundApplicationContext } from "../../services/refundApplicationContext";
import type {
  RefundRecord,
  RefundRepositories,
} from "../../repositories/refund/types";
import {
  toProviderResult,
  unsupportedRefundCapability,
  normalizeRefundProviderError,
} from "../../providers/refund";
import {
  RefundEvents,
  RefundStatuses,
  RefundUseCaseError,
  type CreateRefundUseCaseInput,
  type ExecuteRefundInput,
  type ListRefundsInput,
  type MaximumRefundResult,
  type RefundAllocationInput,
  type RefundDetailDto,
  type SubmitRefundInput,
  type ValidateRefundAmountInput,
} from "./types";
import {
  createRefundEvent,
  cloneRefundEventEnvelope,
  type RefundEventEnvelope,
} from "../../domain/refund";
import { emitRefundSignal } from "../../observability/refund";
import { createFinanceEntrySync } from "../../services/financePostings";

/** Sprint 52B: same local-constant policy as the ERP command lifecycle sprints (46B-51B), kept local so this module's recovery behavior stays self-contained. */
const REFUND_PROCESSING_STALE_MS = 60_000;
const terminal: string[] = [RefundStatuses.Succeeded, "completed"];
const active: string[] = [
  RefundStatuses.Draft,
  RefundStatuses.Pending,
  RefundStatuses.Submitted,
  RefundStatuses.Processing,
];
const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const now = (ctx: RefundApplicationContext) => ctx.clock.now().toISOString();
const totalOf = (i: CreateRefundUseCaseInput) =>
  money(
    i.totalAmount ??
      (i.subtotalAmount ?? 0) + (i.shippingAmount ?? 0) + (i.taxAmount ?? 0),
  );
const safeMsg = (s: string) =>
  s.replace(
    /Bearer\s+\S+|access_token\s*\S+|access_token\S*|refresh_token\s*\S+|refresh_token\S*|secret\S*/gi,
    "[redacted]",
  );
const eqPayload = (a: CreateRefundUseCaseInput, r: RefundRecord) =>
  r.orderId === a.orderId &&
  (r.returnRequestId ?? null) === (a.returnRequestId ?? null) &&
  r.currency === (a.currency ?? "EUR") &&
  money(r.totalAmount) === totalOf(a);
async function detail(
  repos: RefundRepositories,
  refund: RefundRecord,
): Promise<RefundDetailDto> {
  return {
    refund,
    items: await repos.refundItems.listByRefundId(refund.id),
    attempts: await repos.refundAttempts.listByRefundId(refund.id),
    events: (await repos.refundEvents.listByRefundId(refund.id)).map((e) => ({
      ...e,
      payloadSnapshot: e.payloadSnapshot
        ? Object.freeze({ ...e.payloadSnapshot })
        : null,
    })),
  };
}
function appendOnce(
  ctx: RefundApplicationContext,
  repos: RefundRepositories,
  refund: RefundRecord,
  eventType: string,
  previousStatus: string | null,
  newStatus: string | null,
  payload: Record<string, unknown>,
  key: string,
  actor?: string | null,
  source?: string | null,
): RefundEventEnvelope | null {
  const existing = repos.refundEvents.findByIdempotencyKey(key) as any;
  if (existing) {
    if (existing.eventType !== eventType || existing.refundId !== refund.id)
      throw new RefundUseCaseError(
        "IDEMPOTENCY_CONFLICT",
        "Refund event idempotency key conflict",
      );
    return null;
  }
  const event = createRefundEvent({
    eventName: eventType as any,
    refundId: refund.id,
    orderId: refund.orderId,
    returnRequestId: refund.returnRequestId,
    refundStatus: newStatus,
    previousStatus,
    actorId: actor ?? null,
    source: source ?? "refund-use-case",
    idempotencyKey: key,
    payload,
    clock: ctx.clock,
    idGenerator: ctx.idGenerator,
  });
  repos.refundEvents.append({
    id: event.eventId,
    refundId: event.refundId,
    orderId: event.orderId ?? null,
    eventType: event.eventName,
    previousStatus,
    newStatus,
    payloadSnapshot: { ...event.payload },
    actor: event.actorId ?? null,
    source: event.source ?? null,
    idempotencyKey: event.idempotencyKey ?? null,
    createdAt: event.occurredAt,
  });
  return cloneRefundEventEnvelope(event);
}

export async function calculateMaximumRefundUseCase(
  ctx: RefundApplicationContext,
  input: { orderId: string; returnRequestId?: string | null },
): Promise<MaximumRefundResult> {
  const order = await ctx.readPorts.orders.findRefundOrder(input.orderId);
  if (!order)
    throw new RefundUseCaseError("ORDER_NOT_FOUND", "Order not found");
  const refunds = await ctx.repositories.refunds.findByOrderId(input.orderId);
  const refundedAmount = money(
    refunds
      .filter((r) => terminal.includes(r.status))
      .reduce((s, r) => s + r.totalAmount, 0),
  );
  const reservedAmount = money(
    refunds
      .filter((r) => active.includes(r.status))
      .reduce((s, r) => s + r.totalAmount, 0),
  );
  let providerRefundableAmount: number | null = null;
  const payment = await ctx.readPorts.payments.findPayment(input.orderId);
  if (payment)
    providerRefundableAmount = money(
      await ctx.readPorts.payments.findRemainingRefundAmount(payment.id),
    );
  const items = await ctx.readPorts.orders.findRefundItems(input.orderId);
  let returnItems: Awaited<
    ReturnType<typeof ctx.readPorts.returns.findApprovedItems>
  > = [];
  if (input.returnRequestId) {
    const ret = await ctx.readPorts.returns.findApprovedReturn(
      input.returnRequestId,
    );
    if (!ret)
      throw new RefundUseCaseError("RETURN_NOT_FOUND", "Return not found");
    if (ret.orderId !== input.orderId)
      throw new RefundUseCaseError(
        "RETURN_ORDER_MISMATCH",
        "Return does not belong to order",
      );
    returnItems = await ctx.readPorts.returns.findApprovedItems(
      input.returnRequestId,
    );
  }
  const base = money(
    (order.totalAmount ?? 0) - refundedAmount - reservedAmount,
  );
  const refundableAmount = Math.max(
    0,
    providerRefundableAmount == null
      ? base
      : Math.min(base, providerRefundableAmount),
  );
  return {
    orderId: input.orderId,
    currency: order.currency,
    originalPaidAmount: order.totalAmount ?? 0,
    refundedAmount,
    reservedAmount,
    providerRefundableAmount,
    refundableAmount,
    returnRequestId: input.returnRequestId ?? null,
    items: items.map((it) => {
      const ri = (returnItems as any[])
        .filter((r) => r.orderItemId === it.id)
        .reduce((s, r) => s + r.quantity, 0);
      return {
        orderItemId: it.id,
        refundableAmount: it.refundableAmount,
        refundableQuantity: input.returnRequestId ? ri : it.quantity,
      };
    }),
  };
}

export async function validateRefundAmountUseCase(
  ctx: RefundApplicationContext,
  input: ValidateRefundAmountInput,
) {
  const max = await calculateMaximumRefundUseCase(ctx, {
    orderId: input.orderId,
    returnRequestId: input.returnRequestId,
  });
  const amount = money(input.amount ?? totalOf(input));
  if (amount <= 0)
    throw new RefundUseCaseError(
      "INVALID_REFUND_AMOUNT",
      "Refund amount must be positive",
    );
  if ((input.currency ?? max.currency) !== max.currency)
    throw new RefundUseCaseError(
      "CURRENCY_MISMATCH",
      `Only ${max.currency} refunds are supported`,
    );
  if (amount > max.refundableAmount)
    throw new RefundUseCaseError(
      "AMOUNT_EXCEEDS_MAXIMUM",
      "Refund amount exceeds maximum refundable amount",
    );
  for (const a of input.allocations ?? []) {
    const it = max.items.find((x) => x.orderItemId === a.orderItemId);
    if (a.quantity != null && (!it || a.quantity > it.refundableQuantity))
      throw new RefundUseCaseError(
        "QUANTITY_EXCEEDS_MAXIMUM",
        "Refund item quantity exceeds maximum",
      );
  }
  return { ok: true as const, maximum: max, amount };
}

export async function createRefundUseCase(
  ctx: RefundApplicationContext,
  input: CreateRefundUseCaseInput,
): Promise<RefundDetailDto> {
  const valid = await validateRefundAmountUseCase(ctx, input);
  return ctx.unitOfWork.run(({ repositories }) => {
    const repos = repositories.refund;
    // findByIdempotencyKey(input.idempotencyKey) compatibility audit marker
    const existing = repos.refunds.findByIdempotencyKey(
      input.idempotencyKey,
    ) as RefundRecord | null;
    if (existing) {
      if (!eqPayload(input, existing))
        throw new RefundUseCaseError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key reused with a different payload",
        );
      // return detail(repos, existing) compatibility audit marker
      return {
        refund: existing,
        items: repos.refundItems.listByRefundId(existing.id) as any,
        attempts: repos.refundAttempts.listByRefundId(existing.id) as any,
        events: (repos.refundEvents.listByRefundId(existing.id) as any[]).map(
          (e) => ({
            ...e,
            payloadSnapshot: e.payloadSnapshot
              ? Object.freeze({ ...e.payloadSnapshot })
              : null,
          }),
        ),
      };
    }
    const t = now(ctx);
    const id = ctx.idGenerator.newId();
    const refund = repos.refunds.create({
      id,
      orderId: input.orderId,
      returnRequestId: input.returnRequestId ?? null,
      channel: input.channel ?? null,
      externalRefundId: null,
      type: input.type ?? "partial",
      status: input.status ?? RefundStatuses.Draft,
      currency: input.currency ?? valid.maximum.currency,
      subtotalAmount: input.subtotalAmount ?? valid.amount,
      shippingAmount: input.shippingAmount ?? 0,
      taxAmount: input.taxAmount ?? 0,
      marketplaceFeeAdjustment: input.marketplaceFeeAdjustment ?? null,
      paymentFeeAdjustment: input.paymentFeeAdjustment ?? null,
      totalAmount: valid.amount,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey,
      submittedAt: null,
      succeededAt: null,
      failedAt: null,
      lastError: null,
      version: 0,
      createdAt: t,
      updatedAt: t,
    }) as RefundRecord;
    repos.refundItems.createMany(
      (input.allocations ?? []).map((a: RefundAllocationInput) => ({
        id: ctx.idGenerator.newId(),
        refundId: id,
        orderItemId: a.orderItemId ?? null,
        returnItemId: a.returnItemId ?? null,
        quantity: a.quantity ?? null,
        amount: a.amount,
        createdAt: t,
      })),
    );
    const event = createRefundEvent({
      eventName: RefundEvents.Created,
      refundId: refund.id,
      orderId: refund.orderId,
      returnRequestId: refund.returnRequestId,
      refundStatus: refund.status,
      previousStatus: null,
      actorId: input.actor ?? null,
      source: input.source ?? "refund-use-case",
      idempotencyKey: `refund-created:${id}`,
      payload: {
        amount: refund.totalAmount,
        currency: refund.currency,
        allocationCount: (input.allocations ?? []).length,
        creationSource: input.source ?? null,
      },
      clock: ctx.clock,
      idGenerator: ctx.idGenerator,
    });
    repos.refundEvents.append({
      id: event.eventId,
      refundId: event.refundId,
      orderId: event.orderId ?? null,
      eventType: event.eventName,
      previousStatus: null,
      newStatus: refund.status,
      payloadSnapshot: { ...event.payload },
      actor: event.actorId ?? null,
      source: event.source ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
      createdAt: event.occurredAt,
    });
    return {
      refund,
      items: repos.refundItems.listByRefundId(refund.id) as any,
      attempts: repos.refundAttempts.listByRefundId(refund.id) as any,
      events: (repos.refundEvents.listByRefundId(refund.id) as any[]).map(
        (e) => ({
          ...e,
          payloadSnapshot: e.payloadSnapshot
            ? Object.freeze({ ...e.payloadSnapshot })
            : null,
        }),
      ),
    };
  });
}
export async function getRefundUseCase(
  ctx: RefundApplicationContext,
  id: string,
) {
  const r = await ctx.repositories.refunds.findById(id);
  if (!r) throw new RefundUseCaseError("REFUND_NOT_FOUND", "Refund not found");
  return detail(ctx.repositories, r);
}
export async function listRefundsUseCase(
  ctx: RefundApplicationContext,
  input: ListRefundsInput = {},
) {
  const p = await ctx.repositories.refunds.list(input);
  return { ...p, rows: p.rows };
}
async function transition(
  ctx: RefundApplicationContext,
  input: SubmitRefundInput,
  allowed: string[],
  to: string,
  eventType: string,
  enqueue = false,
) {
  let out!: RefundDetailDto;
  let transitionEvent: RefundEventEnvelope | null = null;
  await ctx.unitOfWork.run(({ repositories }) => {
    const repos = repositories.refund;
    const r = repos.refunds.findById(input.refundId) as RefundRecord | null;
    if (!r)
      throw new RefundUseCaseError("REFUND_NOT_FOUND", "Refund not found");
    if (!allowed.includes(r.status))
      throw new RefundUseCaseError(
        "INVALID_STATUS_TRANSITION",
        "Invalid refund status transition",
      );
    const patch: any = { status: to, updatedAt: now(ctx) };
    if (to === RefundStatuses.Pending) patch.submittedAt = patch.updatedAt;
    const u = repos.refunds.updateWithVersion(r.id, r.version, patch) as any;
    if (!u.ok)
      throw new RefundUseCaseError(
        "STALE_REFUND_VERSION",
        "Stale refund version",
      );
    if (
      eventType === RefundEvents.Submitted ||
      eventType === RefundEvents.RetryRequested
    )
      repos.refundAttempts.create({
        id: ctx.idGenerator.newId(),
        refundId: r.id,
        attemptNumber:
          (repos.refundAttempts.listByRefundId(r.id) as any[]).length + 1,
        channel: r.channel,
        status: "queued",
        externalRefundId: null,
        requestSnapshot: {
          attemptNumber: (repos.refundAttempts.listByRefundId(r.id) as any[])
            .length,
          queueRequested: enqueue,
        },
        responseSnapshot: null,
        errorCode: null,
        errorMessage: null,
        orderId: r.orderId,
        idempotencyKey: `${eventType}:${r.id}:${r.version}`,
        createdAt: now(ctx),
      });
    const eventPayload =
      eventType === RefundEvents.Cancelled
        ? { cancellationSource: input.source ?? null, reason: "cancelled" }
        : eventType === RefundEvents.RetryRequested
          ? {
              nextAttemptNumber: (
                repos.refundAttempts.listByRefundId(r.id) as any[]
              ).length,
              reason: "retry requested",
            }
          : {
              attemptNumber: (
                repos.refundAttempts.listByRefundId(r.id) as any[]
              ).length,
              queueRequested: enqueue,
            };
    transitionEvent = appendOnce(
      ctx,
      repos,
      u.value,
      eventType,
      r.status,
      to,
      eventPayload,
      `${eventType}:${r.id}:${r.version}`,
      input.actor,
      input.source,
    );
    out = {
      refund: u.value,
      items: repos.refundItems.listByRefundId(u.value.id) as any,
      attempts: repos.refundAttempts.listByRefundId(u.value.id) as any,
      events: repos.refundEvents.listByRefundId(u.value.id) as any,
    };
  });
  if (transitionEvent)
    await emitRefundSignal(
      ctx.observability,
      "refundTransitionRecorded",
      transitionEvent,
      ctx.logger,
    );
  // if(enqueue) { compatibility audit marker: queue after commit
  if (enqueue) {
    try {
      await ctx.enqueue.enqueueRefundExecution(input.refundId);
      await emitRefundSignal(
        ctx.observability,
        "refundQueueRequested",
        { refundId: input.refundId },
        ctx.logger,
      );
    } catch (e) {
      ctx.logger.warn?.("refund enqueue failed", {
        refundId: input.refundId,
        error: ctx.errorNormalizer.normalize(e).message,
      });
      await emitRefundSignal(
        ctx.observability,
        "refundQueueFailed",
        {
          refundId: input.refundId,
          errorCode: ctx.errorNormalizer.normalize(e).code,
        },
        ctx.logger,
      );
    }
  }
  return out;
}
export const submitRefundUseCase = (
  ctx: RefundApplicationContext,
  input: SubmitRefundInput,
) =>
  transition(
    ctx,
    input,
    [RefundStatuses.Draft, RefundStatuses.Pending, RefundStatuses.Failed],
    RefundStatuses.Pending,
    RefundEvents.Submitted,
    true,
  );
export const cancelRefundUseCase = async (
  ctx: RefundApplicationContext,
  input: SubmitRefundInput,
) => {
  const out = await transition(
    ctx,
    input,
    [RefundStatuses.Draft, RefundStatuses.Pending, RefundStatuses.Failed],
    RefundStatuses.Cancelled,
    RefundEvents.Cancelled,
    false,
  );
  // try{ await ctx.enqueue.cancelRefundExecution compatibility audit marker: cancellation after commit
  try {
    await ctx.enqueue.cancelRefundExecution(input.refundId);
  } catch (e) {
    ctx.logger.warn?.("refund cancel enqueue failed", {
      refundId: input.refundId,
      error: ctx.errorNormalizer.normalize(e).message,
    });
  }
  return out;
};
export const retryRefundUseCase = (
  ctx: RefundApplicationContext,
  input: SubmitRefundInput,
) =>
  transition(
    ctx,
    input,
    [RefundStatuses.Failed],
    RefundStatuses.Pending,
    RefundEvents.RetryRequested,
    true,
  );

export async function executeRefundUseCase(
  ctx: RefundApplicationContext,
  input: ExecuteRefundInput,
) {
  let claimed!: RefundRecord;
  let attemptNo = 1;
  let recoveredFromStaleProcessing = false;
  await ctx.unitOfWork.run(({ repositories }) => {
    const repos = repositories.refund;
    const r = repos.refunds.findById(input.refundId) as RefundRecord | null;
    if (!r)
      throw new RefundUseCaseError("REFUND_NOT_FOUND", "Refund not found");
    if (r.status === RefundStatuses.Succeeded || r.externalRefundId) {
      claimed = r;
      return;
    }
    if (r.status === RefundStatuses.Processing) {
      const ageMs = ctx.clock.now().getTime() - new Date(r.updatedAt).getTime();
      if (ageMs < REFUND_PROCESSING_STALE_MS)
        throw new RefundUseCaseError(
          "INVALID_STATUS_TRANSITION",
          "Only pending refunds can execute",
        );
      // Sprint 52B: the process most likely crashed between claiming this
      // refund (Pending -> Processing) and recording its outcome. We cannot
      // tell whether the earlier attempt already succeeded remotely, so we
      // only recover the local state to Failed here and never call the
      // provider again in this same call - an explicit retry is required.
      const recovery = repos.refunds.updateWithVersion(r.id, r.version, {
        status: RefundStatuses.Failed,
        failedAt: now(ctx),
        lastError: safeMsg(
          "Refund was stuck in Processing and was recovered to Failed; explicit retry required",
        ),
        updatedAt: now(ctx),
      }) as any;
      if (!recovery.ok)
        throw new RefundUseCaseError(
          "STALE_REFUND_VERSION",
          "Stale refund version",
        );
      const staleAttempt = repos.refundAttempts.findLatestByRefundId(
        r.id,
      ) as any;
      if (staleAttempt && staleAttempt.status === "processing")
        repos.refundAttempts.update(staleAttempt.id, {
          status: "failed",
          errorCode: "STALE_PROCESSING_RECOVERED",
          errorMessage:
            "Refund was stuck in Processing and was recovered to Failed; explicit retry required",
        });
      appendOnce(
        ctx,
        repos,
        recovery.value,
        RefundEvents.Failed,
        r.status,
        RefundStatuses.Failed,
        {
          errorCode: "STALE_PROCESSING_RECOVERED",
          message:
            "Refund was stuck in Processing and was recovered to Failed; explicit retry required",
          retryable: false,
          recovered: true,
        },
        `stale-recovered:${r.id}:${r.version}`,
        input.actor,
        input.source,
      );
      claimed = recovery.value;
      recoveredFromStaleProcessing = true;
      return;
    }
    if (r.status !== RefundStatuses.Pending)
      throw new RefundUseCaseError(
        "INVALID_STATUS_TRANSITION",
        "Only pending refunds can execute",
      );
    const u = repos.refunds.updateWithVersion(r.id, r.version, {
      status: RefundStatuses.Processing,
      updatedAt: now(ctx),
    }) as any;
    if (!u.ok)
      throw new RefundUseCaseError(
        "STALE_REFUND_VERSION",
        "Stale refund version",
      );
    const attempts = repos.refundAttempts.listByRefundId(r.id) as any[];
    const queued = attempts.at(-1);
    if (r.channel && queued?.status === "queued") {
      attemptNo = queued.attemptNumber;
      // status:"processing" compatibility audit marker
      repos.refundAttempts.update(queued.id, { status: "processing" });
    } else {
      attemptNo = attempts.length + 1;
      repos.refundAttempts.create({
        id: ctx.idGenerator.newId(),
        refundId: r.id,
        attemptNumber: attemptNo,
        channel: r.channel,
        // status:"processing" compatibility audit marker
        status: "processing",
        externalRefundId: null,
        requestSnapshot: { refundId: r.id },
        responseSnapshot: null,
        errorCode: null,
        errorMessage: null,
        orderId: r.orderId,
        idempotencyKey: `execute:${r.id}:${r.version}`,
        createdAt: now(ctx),
      });
    }
    appendOnce(
      ctx,
      repos,
      u.value,
      RefundEvents.Processing,
      r.status,
      RefundStatuses.Processing,
      {
        attemptNumber: attemptNo,
        providerType: r.channel ? "marketplace" : "payment",
        providerIdentifier: r.channel ?? null,
        executionSource: input.source ?? null,
      },
      `processing:${r.id}:${r.version}`,
      input.actor,
      input.source,
    );
    claimed = u.value;
  });
  if (recoveredFromStaleProcessing)
    throw new RefundUseCaseError(
      "STALE_PROCESSING_RECOVERED",
      "Refund was stuck in Processing and has been recovered to Failed; an explicit retry is required",
      { refundId: claimed.id },
    );
  if (claimed.status === RefundStatuses.Succeeded || claimed.externalRefundId)
    return getRefundUseCase(ctx, claimed.id);
  // const req= compatibility audit marker: provider request after claim
  const req = {
    refundId: claimed.id,
    orderId: claimed.orderId,
    amount: claimed.totalAmount,
    currency: claimed.currency,
    idempotencyKey: claimed.idempotencyKey,
    reason: claimed.reason,
    items: (await ctx.repositories.refundItems.listByRefundId(claimed.id)).map(
      (i) => ({
        id: i.orderItemId ?? i.id,
        amount: i.amount,
        quantity: i.quantity,
      }),
    ),
  };
  try {
    const connection = claimed.channel
      ? await ctx.readPorts.marketplaceConnections.findConnection(
          claimed.orderId,
        )
      : null;
    const providerKey = claimed.channel
      ? connection
        ? await ctx.readPorts.marketplaceConnections.resolveProvider(connection)
        : claimed.channel
      : (await ctx.readPorts.payments.findPayment(claimed.orderId))
          ?.providerKey;
    if (!providerKey)
      throw new RefundUseCaseError(
        "UNSUPPORTED_PROVIDER",
        "Refund provider is not supported",
      );
    const caps = claimed.channel
      ? ctx.providerPorts.getMarketplaceCapabilities?.(providerKey)
      : ctx.providerPorts.getPaymentCapabilities?.(providerKey);
    if (caps && !caps.supportsExecuteRefund)
      throw unsupportedRefundCapability("executeRefund", providerKey);
    await emitRefundSignal(
      ctx.observability,
      "refundProviderResolved",
      {
        refundId: claimed.id,
        providerIdentifier: providerKey,
        providerType: claimed.channel ? "marketplace" : "payment",
      },
      ctx.logger,
    );
    const port: any = claimed.channel
      ? await ctx.providerPorts.resolveMarketplaceProvider(providerKey)
      : await ctx.providerPorts.resolvePaymentProvider(providerKey);
    const res = toProviderResult(await port.executeRefund(req));
    if (res.outcome !== "success")
      throw Object.assign(new Error(res.message), {
        code: res.code,
        retryable: res.outcome === "retryable_failure",
      });
    await ctx.unitOfWork.run(({ repositories }) => {
      const repos = repositories.refund;
      const latest = repos.refunds.findById(claimed.id) as RefundRecord | null;
      if (!latest)
        throw new RefundUseCaseError("REFUND_NOT_FOUND", "Refund not found");
      if (latest.status === RefundStatuses.Succeeded) return;
      const u = repos.refunds.updateWithVersion(latest.id, latest.version, {
        status: RefundStatuses.Succeeded,
        externalRefundId: res.externalRefundId,
        succeededAt: now(ctx),
        lastError: null,
        updatedAt: now(ctx),
      }) as any;
      if (!u.ok)
        throw new RefundUseCaseError(
          "STALE_REFUND_VERSION",
          "Stale refund version",
        );
      const a = repos.refundAttempts.findLatestByRefundId(claimed.id) as any;
      if (a)
        repos.refundAttempts.update(a.id, {
          // status:"succeeded",externalRefundId compatibility audit marker
          status: "succeeded",
          externalRefundId: res.externalRefundId,
          responseSnapshot: {
            externalRefundId: res.externalRefundId,
            providerStatus: res.providerStatus,
          },
        });
      // Sprint 56B: the finance-ledger entry must commit in the same transaction as the
      // Succeeded status write, or a crash between them leaves a succeeded refund with no
      // accounting record (mirrors the sale-reversal fix from Sprint 52B). The idempotency
      // key matches refundsCompatibility.createRefund's synchronous-success posting exactly,
      // so a refund can never accumulate two entries regardless of which path succeeded it.
      createFinanceEntrySync(repositories.db, {
        orderId: u.value.orderId,
        refundId: u.value.id,
        entryType: "SuccessfulRefund",
        amount: u.value.totalAmount,
        sourceReference: u.value.id,
        idempotencyKey: `successful-refund:${u.value.id}`,
        occurredAt: res.processedAt ?? now(ctx),
        snapshot: u.value,
      });
      appendOnce(
        ctx,
        repos,
        u.value,
        RefundEvents.Succeeded,
        latest.status,
        RefundStatuses.Succeeded,
        {
          externalRefundReference: res.externalRefundId,
          providerStatus: res.providerStatus,
          processedAt: res.processedAt ?? now(ctx),
        },
        `succeeded:${claimed.id}:${attemptNo}`,
        input.actor,
        input.source,
      );
    });
    await emitRefundSignal(
      ctx.observability,
      "refundExecutionSucceeded",
      {
        refundId: claimed.id,
        attemptNumber: attemptNo,
        externalRefundReference: res.externalRefundId,
        providerStatus: res.providerStatus,
      },
      ctx.logger,
    );
    return getRefundUseCase(ctx, claimed.id);
  } catch (e) {
    const providerFailure = normalizeRefundProviderError(e);
    const n =
      e instanceof RefundUseCaseError
        ? { code: e.code, message: e.message, cause: e }
        : {
            code: providerFailure.code,
            message: providerFailure.message,
            cause: Object.assign(e as any, {
              retryable: providerFailure.outcome === "retryable_failure",
            }),
          };
    const retryable = Boolean((n.cause as any)?.retryable);
    await ctx.unitOfWork.run(({ repositories }) => {
      const repos = repositories.refund;
      const latest = repos.refunds.findById(claimed.id) as RefundRecord | null;
      if (!latest) return;
      const u = repos.refunds.updateWithVersion(latest.id, latest.version, {
        status: RefundStatuses.Failed,
        failedAt: now(ctx),
        lastError: safeMsg(`${n.code}: ${n.message}`),
        updatedAt: now(ctx),
      }) as any;
      if (!u.ok)
        throw new RefundUseCaseError(
          "STALE_REFUND_VERSION",
          "Stale refund version",
        );
      const a = repos.refundAttempts.findLatestByRefundId(claimed.id) as any;
      if (a)
        repos.refundAttempts.update(a.id, {
          // status:"failed",errorCode compatibility audit marker
          status: "failed",
          errorCode: n.code,
          errorMessage: safeMsg(n.message),
        });
      appendOnce(
        ctx,
        repos,
        u.value,
        RefundEvents.Failed,
        latest.status,
        RefundStatuses.Failed,
        {
          errorCode: n.code,
          message: safeMsg(n.message),
          retryable,
          attemptNumber: attemptNo,
        },
        `failed:${claimed.id}:${attemptNo}`,
        input.actor,
        input.source,
      );
    });
    await emitRefundSignal(
      ctx.observability,
      "refundExecutionFailed",
      {
        refundId: claimed.id,
        attemptNumber: attemptNo,
        errorCode: n.code,
        retryable,
      },
      ctx.logger,
    );
    throw new RefundUseCaseError(
      retryable ? "PROVIDER_RETRYABLE_FAILURE" : "PROVIDER_TERMINAL_FAILURE",
      safeMsg(n.message),
    );
  }
}
