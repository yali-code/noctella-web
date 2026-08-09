export enum PaymentStatus {
  Pending = "pending",
  Processing = "processing",
  Paid = "paid",
  ManualRefundRequired = "manual_refund_required",
  Failed = "failed",
  Cancelled = "cancelled",
}

export const PAYMENT_STATUS_VALUES: PaymentStatus[] = Object.values(PaymentStatus);
