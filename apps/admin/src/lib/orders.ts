import { api } from "./api";
import type { Order, OrderItem } from "@noctella/shared";

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
