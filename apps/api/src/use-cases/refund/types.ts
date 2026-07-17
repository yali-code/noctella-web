import type {
  RefundApplicationContext,
  RefundProviderRequest,
} from "../../services/refundApplicationContext";
import type {
  RefundAttemptRecord,
  RefundEventRecord,
  RefundItemRecord,
  RefundListQuery,
  RefundRecord,
  RefundRepositories,
} from "../../repositories/refund/types";

export type RefundStatusValue =
  | "draft"
  | "pending"
  | "submitted"
  | "processing"
  | "succeeded"
  | "completed"
  | "failed"
  | "cancelled";
export const RefundStatuses = {
  Draft: "draft",
  Pending: "pending",
  Submitted: "submitted",
  Processing: "processing",
  Succeeded: "succeeded",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export {
  RefundEventNames as RefundEvents,
  type RefundEventName,
} from "../../domain/refund";
export type RefundUseCaseContext = RefundApplicationContext;
export type RefundErrorCode =
  | "REFUND_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "RETURN_NOT_FOUND"
  | "RETURN_ORDER_MISMATCH"
  | "INVALID_REFUND_AMOUNT"
  | "CURRENCY_MISMATCH"
  | "AMOUNT_EXCEEDS_MAXIMUM"
  | "QUANTITY_EXCEEDS_MAXIMUM"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATUS_TRANSITION"
  | "STALE_REFUND_VERSION"
  | "UNSUPPORTED_PROVIDER"
  | "PROVIDER_RETRYABLE_FAILURE"
  | "PROVIDER_TERMINAL_FAILURE";
export class RefundUseCaseError extends Error {
  constructor(
    public code: RefundErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RefundUseCaseError";
  }
}
export interface RefundAllocationInput {
  orderItemId?: string | null;
  returnItemId?: string | null;
  quantity?: number | null;
  amount: number;
}
export interface CreateRefundUseCaseInput {
  orderId: string;
  returnRequestId?: string | null;
  channel?: string | null;
  type?: string;
  status?: string;
  currency?: string;
  subtotalAmount?: number;
  shippingAmount?: number;
  taxAmount?: number;
  marketplaceFeeAdjustment?: number | null;
  paymentFeeAdjustment?: number | null;
  totalAmount?: number;
  reason?: string | null;
  idempotencyKey: string;
  allocations?: RefundAllocationInput[];
  actor?: string | null;
  source?: string | null;
}
export interface ValidateRefundAmountInput extends CreateRefundUseCaseInput {
  amount?: number;
}
export interface MaximumRefundResult {
  orderId: string;
  currency: string;
  originalPaidAmount: number;
  refundedAmount: number;
  reservedAmount: number;
  providerRefundableAmount: number | null;
  refundableAmount: number;
  items: Array<{
    orderItemId: string;
    refundableAmount: number;
    refundableQuantity: number;
  }>;
  returnRequestId?: string | null;
}
export interface RefundDetailDto {
  refund: RefundRecord;
  items: RefundItemRecord[];
  attempts: RefundAttemptRecord[];
  events: RefundEventRecord[];
}
export interface ListRefundsInput extends RefundListQuery {}
export interface ExecuteRefundInput {
  refundId: string;
  actor?: string | null;
  source?: string | null;
}
export interface SubmitRefundInput {
  refundId: string;
  actor?: string | null;
  source?: string | null;
}
export interface CancelRefundInput extends SubmitRefundInput {}
export interface RetryRefundInput extends SubmitRefundInput {}
export type { RefundRecord, RefundRepositories, RefundProviderRequest };
