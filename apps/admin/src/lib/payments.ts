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

export function listPaymentSessions(filters: PaymentSessionFilters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.provider) params.set("provider", filters.provider);
  const query = params.toString();
  return api.get<PaymentSessionRow[]>(`/api/payments${query ? `?${query}` : ""}`);
}
