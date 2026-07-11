import type { CartItem } from "./cart";
import { cartEurSubtotal, cartUsdSubtotal } from "./cart";
import { type Address, type CheckoutDraft, isCheckoutDraftValid } from "./checkout";

const STORAGE_KEY = "noctella_order_draft";

export interface OrderDraftCustomer {
  email: string;
  phone?: string;
  firstName: string;
  lastName: string;
  company?: string;
}

export interface CurrencySummary {
  eurSubtotal: number;
  usdSubtotal?: number;
}

export type OrderDraftStatus = "draft";

export interface OrderDraft {
  id: string;
  items: CartItem[];
  customer: OrderDraftCustomer;
  shippingAddress: Address;
  billingAddress?: Address;
  billingSameAsShipping: boolean;
  customerNote?: string;
  currencySummary: CurrencySummary;
  status: OrderDraftStatus;
  createdAt: string;
  updatedAt: string;
}

function toOrderDraftCustomer(checkoutDraft: CheckoutDraft): OrderDraftCustomer {
  return {
    email: checkoutDraft.contact.email,
    phone: checkoutDraft.contact.phone,
    firstName: checkoutDraft.customer.firstName,
    lastName: checkoutDraft.customer.lastName,
    company: checkoutDraft.customer.company,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Builds an order draft from the current cart + checkout draft. Returns
 * null when there's nothing valid to build from (empty cart, or missing /
 * invalid checkout details) — the review page decides how to message that.
 *
 * If an existing draft is passed and its content (items, customer,
 * addresses, note) exactly matches what would be built now, the *same*
 * draft (same id/createdAt) is returned — this is what keeps the id stable
 * across a plain refresh. Any difference produces a fresh draft with a new
 * id, which is the "rebuild" behavior when the cart or checkout details
 * change.
 */
export function buildOrderDraft(
  items: CartItem[],
  checkoutDraft: CheckoutDraft | null,
  existingDraft: OrderDraft | null,
): OrderDraft | null {
  if (items.length === 0) return null;
  if (!checkoutDraft || !isCheckoutDraftValid(checkoutDraft)) return null;

  const customer = toOrderDraftCustomer(checkoutDraft);
  const shippingAddress = checkoutDraft.shippingAddress;
  const billingAddress = checkoutDraft.billingSameAsShipping ? undefined : checkoutDraft.billingAddress;
  const currencySummary: CurrencySummary = {
    eurSubtotal: cartEurSubtotal(items),
    usdSubtotal: cartUsdSubtotal(items),
  };

  if (
    existingDraft &&
    deepEqual(existingDraft.items, items) &&
    deepEqual(existingDraft.customer, customer) &&
    deepEqual(existingDraft.shippingAddress, shippingAddress) &&
    deepEqual(existingDraft.billingAddress, billingAddress) &&
    existingDraft.billingSameAsShipping === checkoutDraft.billingSameAsShipping &&
    existingDraft.customerNote === checkoutDraft.customerNote
  ) {
    return existingDraft;
  }

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    items,
    customer,
    shippingAddress,
    billingAddress,
    billingSameAsShipping: checkoutDraft.billingSameAsShipping,
    customerNote: checkoutDraft.customerNote,
    currencySummary,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

function isValidAddressShape(value: unknown): value is Address {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.line1 === "string" &&
    typeof v.city === "string" &&
    typeof v.postalCode === "string" &&
    typeof v.country === "string" &&
    typeof v.countryCode === "string"
  );
}

function isValidOrderDraftShape(value: unknown): value is OrderDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const customer = v.customer as Record<string, unknown> | undefined;
  const currencySummary = v.currencySummary as Record<string, unknown> | undefined;
  return (
    typeof v.id === "string" &&
    Array.isArray(v.items) &&
    typeof customer === "object" &&
    customer !== null &&
    typeof customer.email === "string" &&
    typeof customer.firstName === "string" &&
    typeof customer.lastName === "string" &&
    isValidAddressShape(v.shippingAddress) &&
    (v.billingAddress === undefined || isValidAddressShape(v.billingAddress)) &&
    typeof v.billingSameAsShipping === "boolean" &&
    typeof currencySummary === "object" &&
    currencySummary !== null &&
    typeof currencySummary.eurSubtotal === "number" &&
    v.status === "draft" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

/** localStorage-backed wrapper — no backend, local-only draft. */
export function getOrderDraft(): OrderDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidOrderDraftShape(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveOrderDraft(draft: OrderDraft): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function clearOrderDraft(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Convenience wrapper used by the review page: reads the current cart +
 * checkout draft + any existing stored order draft, builds/rebuilds as
 * needed, persists the result, and returns it (or null if there's nothing
 * valid to build from).
 */
export function getOrRebuildOrderDraft(items: CartItem[], checkoutDraft: CheckoutDraft | null): OrderDraft | null {
  const existing = getOrderDraft();
  const draft = buildOrderDraft(items, checkoutDraft, existing);
  if (draft) {
    saveOrderDraft(draft);
  } else {
    clearOrderDraft();
  }
  return draft;
}
