export enum OrderStatus {
  Pending = "pending",
  Confirmed = "confirmed",
  Processing = "processing",
  Shipped = "shipped",
  Completed = "completed",
  Cancelled = "cancelled",
}

export const ORDER_STATUS_VALUES: OrderStatus[] = Object.values(OrderStatus);
