import { api } from "./api";
import { OrderStatus, type Order, type OrderItem } from "@noctella/shared";

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export interface OrderListResponse {
  data: OrderWithItems[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export function customerName(order: OrderWithItems): string {
  return order.shippingAddress.fullName || order.billingAddress.fullName || "—";
}

/**
 * Sprint 76: every implemented payment provider is currently a mock (no real gateway is
 * integrated yet - see apps/api/src/payments/mockProviders.ts). Labeling it explicitly wherever
 * a provider is shown ensures an operator never mistakes a mock-paid order for a real one. This
 * is a display label only - it must never be used to infer whether a payment actually succeeded.
 */
export function formatPaymentProvider(provider: string | null | undefined): string {
  if (!provider) return "—";
  return `${provider} (mock)`;
}

export function orderListQuery(params: {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  paymentStatus?: string;
}): string {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.paymentStatus) query.set("paymentStatus", params.paymentStatus);
  return query.toString();
}

export function listOrders(params: Parameters<typeof orderListQuery>[0]): Promise<OrderListResponse> {
  return api.get<OrderListResponse>(`/api/orders?${orderListQuery(params)}`);
}

export function getOrder(id: string): Promise<OrderWithItems> {
  return api.get<OrderWithItems>(`/api/orders/${id}`);
}

export function updateOrderStatus(id: string, status: string): Promise<OrderWithItems> {
  return api.patch<OrderWithItems>(`/api/orders/${id}/status`, { status });
}

/**
 * Completed is reached only through this endpoint (never the generic status
 * PATCH). The response is not exception-based for a not-yet-ready order —
 * a "blocked" status is a normal 200 result, not a thrown error.
 */
export interface CompleteSaleResult {
  status: string;
  issues?: string[];
  financials?: unknown;
  alreadyCompleted?: boolean;
}

export function completeSale(orderId: string): Promise<CompleteSaleResult> {
  return api.post<CompleteSaleResult>(`/api/orders/${orderId}/complete-sale`, {});
}

/**
 * Visible Admin action buttons only — deliberately not a mirror of the
 * backend's full ORDER_STATUS_TRANSITIONS graph (use-cases/order/useCases.ts).
 * Completed (owned exclusively by completeSale()) and Shipped (driven only
 * by Shipment InTransit) are intentionally absent as targets; the backend
 * remains the sole authority on whether a transition actually succeeds.
 */
export type OrderStatusAction = "confirm" | "begin-processing" | "cancel";

export interface OrderStatusActionConfig {
  action: OrderStatusAction;
  label: string;
  busyLabel: string;
  target: OrderStatus;
  from: string[];
}

export const ORDER_STATUS_ACTIONS: OrderStatusActionConfig[] = [
  { action: "confirm", label: "Confirm", busyLabel: "Confirming...", target: OrderStatus.Confirmed, from: ["draft", "pending"] },
  { action: "begin-processing", label: "Begin Processing", busyLabel: "Starting...", target: OrderStatus.Processing, from: ["pending", "confirmed"] },
  { action: "cancel", label: "Cancel", busyLabel: "Cancelling...", target: OrderStatus.Cancelled, from: ["draft", "pending", "confirmed", "processing"] },
];

export function canActOnOrderStatus(status: string, action: OrderStatusAction): boolean {
  return ORDER_STATUS_ACTIONS.some((a) => a.action === action && a.from.includes(status));
}

export function getAvailableOrderStatusActions(status: string): OrderStatusActionConfig[] {
  return ORDER_STATUS_ACTIONS.filter((a) => a.from.includes(status));
}

/**
 * Sprint 79 requirement #4: mirrors apps/api's OrderInvoiceOutboxState — the automatic
 * SalesInvoice-draft outbox event's state for this order, never the raw outbox internals.
 */
export type OrderInvoiceOutboxState = "Created" | "Pending" | "Retrying" | "FailedDeadLettered" | "NotApplicableMarketplace" | "NoInvoiceUnpaid";

export interface OrderInvoiceOutboxStatus {
  state: OrderInvoiceOutboxState;
  invoiceId?: string;
  attemptCount?: number;
  lastErrorMessage?: string | null;
}

export function getOrderInvoiceOutboxStatus(orderId: string): Promise<OrderInvoiceOutboxStatus> {
  return api.get<OrderInvoiceOutboxStatus>(`/api/orders/${orderId}/invoice-status`);
}

export interface RetryInvoiceDraftResult {
  retried: boolean;
  reason: "Enqueued" | "Reactivated" | "AlreadyCreated" | "AlreadyInProgress";
  invoiceId?: string;
  status?: string;
}

/** Always re-enqueues/reactivates the durable outbox event - never calls the direct invoice-creation ERP command, so an automatic draft can never bypass the outbox even from this manual Admin trigger. */
export function retryOrderInvoiceDraft(orderId: string): Promise<RetryInvoiceDraftResult> {
  return api.post<RetryInvoiceDraftResult>(`/api/orders/${orderId}/invoice-status/retry`, {});
}
