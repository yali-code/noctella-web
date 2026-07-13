import { api } from "./api";
import type { Address as CheckoutAddress } from "./checkout";
import type { OrderDraft } from "./orderDraft";
import type { PaymentSelection } from "./paymentSelection";

const STORAGE_KEY = "noctella_created_order";

export interface CreateOrderResult {
  id: string;
  orderNumber: string;
}

function toApiAddress(
  address: CheckoutAddress,
  customer: OrderDraft["customer"],
): { fullName: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string; phone?: string } {
  return {
    fullName: `${customer.firstName} ${customer.lastName}`.trim(),
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: customer.phone,
  };
}

export function buildCreateOrderPayload(draft: OrderDraft, payment: PaymentSelection) {
  return {
    orderDraftId: draft.id,
    guestEmail: draft.customer.email,
    paymentStatus: payment.status,
    paymentProvider: payment.provider,
    paymentReference: payment.providerReference,
    currency: payment.currency ?? "EUR",
    billingAddress: toApiAddress(draft.billingAddress ?? draft.shippingAddress, draft.customer),
    shippingAddress: toApiAddress(draft.shippingAddress, draft.customer),
    subtotalAmount: draft.currencySummary.eurSubtotal,
    totalAmount: draft.currencySummary.eurSubtotal,
    notes: draft.customerNote,
    items: draft.items.map((item) => ({ productId: item.productId, quantity: 1 })),
  };
}

export function createOrderFromPaidPayment(draft: OrderDraft, payment: PaymentSelection): Promise<CreateOrderResult> {
  return api.post<CreateOrderResult>("/api/orders", buildCreateOrderPayload(draft, payment));
}

function isValidCreatedOrder(value: unknown): value is CreateOrderResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.orderNumber === "string";
}

export function saveCreatedOrder(order: CreateOrderResult): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
}

export function getCreatedOrder(): CreateOrderResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidCreatedOrder(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}
