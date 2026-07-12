export enum PaymentStatus {
  Pending = "pending",
  Processing = "processing",
  Paid = "paid",
  Failed = "failed",
  Cancelled = "cancelled",
}

export const PAYMENT_STATUS_VALUES: PaymentStatus[] = Object.values(PaymentStatus);
