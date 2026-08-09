import { api } from "./api";

export type PaymentSessionRow = {
  id: string;
  provider: string;
  providerReference: string;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  orderId: string | null;
};

export type PaymentSessionFilters = { status?: string; provider?: string };

export type PaymentOperationsDetail = {
  paymentId: string; provider: string; status: string; amount: number; currency: string;
  expectedAmountCents: number | null; providerReference: string | null;
  providerTransactionReference: string | null; orderId: string | null;
  createdAt: string; updatedAt: string;
  events: Array<{ id: string; providerEventId: string; eventType: string; status: string; resultClassification: string | null; errorCode: string | null; createdAt: string; updatedAt: string }>;
};

export function listPaymentSessions(filters: PaymentSessionFilters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.provider) params.set("provider", filters.provider);
  const query = params.toString();
  return api.get<PaymentSessionRow[]>(`/api/payments${query ? `?${query}` : ""}`);
}

export function getPaymentOperationsDetail(paymentId: string) {
  return api.get<PaymentOperationsDetail>(`/api/payments/${encodeURIComponent(paymentId)}`);
}
