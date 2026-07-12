const STORAGE_KEY = "noctella_payment_selection";

export type PaymentSelectionProvider = "stripe" | "paypal" | "cash_on_delivery";

export interface PaymentSelection {
  orderDraftId: string;
  provider: PaymentSelectionProvider;
  updatedAt: string;
  providerReference?: string;
  status?: string;
  amount?: number;
  currency?: string;
}

const VALID_PROVIDERS: PaymentSelectionProvider[] = ["stripe", "paypal", "cash_on_delivery"];

function isValidPaymentSelection(value: unknown): value is PaymentSelection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orderDraftId === "string" &&
    typeof v.provider === "string" &&
    VALID_PROVIDERS.includes(v.provider as PaymentSelectionProvider) &&
    typeof v.updatedAt === "string" &&
    (v.providerReference === undefined || typeof v.providerReference === "string") &&
    (v.status === undefined || typeof v.status === "string") &&
    (v.amount === undefined || typeof v.amount === "number") &&
    (v.currency === undefined || typeof v.currency === "string")
  );
}

/**
 * localStorage-backed only. Never stores card data or PayPal credentials —
 * just which provider was chosen for which order draft. Reading a stored
 * selection for an orderDraftId other than the one currently in play
 * should be treated as "no selection" by the caller (see
 * `getPaymentSelectionForDraft`), since the selection resets whenever the
 * order draft changes.
 */
export function getPaymentSelection(): PaymentSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidPaymentSelection(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** Returns the stored selection only if it matches the current order draft id; otherwise null (reset). */
export function getPaymentSelectionForDraft(orderDraftId: string): PaymentSelection | null {
  const stored = getPaymentSelection();
  if (!stored || stored.orderDraftId !== orderDraftId) return null;
  return stored;
}

export function savePaymentSelection(
  orderDraftId: string,
  provider: PaymentSelectionProvider,
  result?: { providerReference: string; status: string; amount?: number; currency?: string },
): PaymentSelection {
  const selection: PaymentSelection = {
    orderDraftId,
    provider,
    updatedAt: new Date().toISOString(),
    providerReference: result?.providerReference,
    status: result?.status,
    amount: result?.amount,
    currency: result?.currency,
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  }
  return selection;
}

/** Updates only the status of the currently stored selection (used after verify/cancel). */
export function updatePaymentSelectionStatus(status: string): PaymentSelection | null {
  const current = getPaymentSelection();
  if (!current) return null;
  const updated: PaymentSelection = { ...current, status, updatedAt: new Date().toISOString() };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }
  return updated;
}

export function clearPaymentSelection(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export interface PaymentActionState {
  canVerify: boolean;
  canCancel: boolean;
  isFinal: boolean;
}

/**
 * Pure state-machine rules for the confirm page's actions:
 * pending/processing -> Verify or Cancel; failed -> Retry Verify only;
 * paid/cancelled -> no further actions; any other/invalid status -> no
 * actions offered (safe fallback).
 */
export function getPaymentActionState(status: string | undefined): PaymentActionState {
  if (status === "pending" || status === "processing") {
    return { canVerify: true, canCancel: true, isFinal: false };
  }
  if (status === "failed") {
    return { canVerify: true, canCancel: false, isFinal: false };
  }
  if (status === "paid" || status === "cancelled") {
    return { canVerify: false, canCancel: false, isFinal: true };
  }
  return { canVerify: false, canCancel: false, isFinal: false };
}
