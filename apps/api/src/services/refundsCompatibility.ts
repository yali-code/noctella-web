import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import { BadRequestError, NotFoundError } from "./errors";
import { createFinanceEntry } from "./financePostings";
import { buildRefundServiceContext } from "./refundServiceContext";
import {
  calculateMaximumRefundUseCase,
  cancelRefundUseCase,
  createRefundUseCase,
  executeRefundUseCase,
  getRefundUseCase,
  listRefundsUseCase,
  retryRefundUseCase,
  submitRefundUseCase,
  validateRefundAmountUseCase,
  RefundUseCaseError,
} from "../use-cases/refund";
import type { RefundDetailDto } from "../use-cases/refund";

const normalizeError = (error: unknown) => {
  if (error instanceof RefundUseCaseError) {
    if (error.code === "REFUND_NOT_FOUND" || error.code === "ORDER_NOT_FOUND")
      return new NotFoundError(error.message);
    if (error.code === "PROVIDER_TERMINAL_FAILURE")
      return {
        type: "Authentication",
        message: error.message,
        retryable: false,
      };
    if (error.code === "PROVIDER_RETRYABLE_FAILURE")
      return { type: "Temporary", message: error.message, retryable: true };
    return new BadRequestError(error.message);
  }
  return error;
};
const unwrap = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch (e) {
    throw normalizeError(e);
  }
};
const legacy = (d: RefundDetailDto) => ({ ...d.refund, allocations: d.items });
const context = buildRefundServiceContext;
export async function calculateMaximumRefund(db: DbClient, orderId: string) {
  const r = await unwrap(() =>
    calculateMaximumRefundUseCase(context(db), { orderId }),
  );
  return {
    currency: r.currency,
    originalPaidAmount: r.originalPaidAmount,
    refundedAmount: r.refundedAmount,
    refundableAmount: r.refundableAmount,
  };
}
export async function validateRefundAmount(
  db: DbClient,
  orderId: string,
  amount: number,
) {
  return unwrap(() =>
    validateRefundAmountUseCase(context(db), {
      orderId,
      amount,
      idempotencyKey: `validate:${orderId}:${amount}`,
    }),
  );
}
export async function createRefund(db: DbClient, input: any) {
  return unwrap(async () => {
    const refund = legacy(
      await createRefundUseCase(context(db), {
        ...input,
        allocations: input.allocations ?? [],
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
      }),
    );
    if (refund.status === "succeeded")
      await createFinanceEntry(db, {
        orderId: refund.orderId,
        refundId: refund.id,
        entryType: "SuccessfulRefund",
        amount: refund.totalAmount,
        sourceReference: refund.id,
        idempotencyKey: `successful-refund:${refund.id}`,
        snapshot: refund,
      });
    return refund;
  });
}
export async function getRefund(db: DbClient, id: string) {
  return unwrap(async () => legacy(await getRefundUseCase(context(db), id)));
}
export async function listRefunds(db: DbClient, q: any = {}) {
  const pageSize = Number(q.pageSize ?? 50);
  const page = Number(q.page ?? 1);
  const r = await unwrap(() =>
    listRefundsUseCase(context(db), {
      ...q,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
  );
  return r.rows;
}
export async function submitRefund(db: DbClient, id: string) {
  return unwrap(async () =>
    legacy(await submitRefundUseCase(context(db), { refundId: id })),
  );
}
export async function cancelRefund(db: DbClient, id: string) {
  return unwrap(async () =>
    legacy(await cancelRefundUseCase(context(db), { refundId: id })),
  );
}
export async function retryRefund(db: DbClient, id: string) {
  return unwrap(async () =>
    legacy(await retryRefundUseCase(context(db), { refundId: id })),
  );
}
export async function executeMarketplaceRefund(db: DbClient, refundId: string) {
  return unwrap(async () =>
    legacy(await executeRefundUseCase(context(db), { refundId })),
  );
}
