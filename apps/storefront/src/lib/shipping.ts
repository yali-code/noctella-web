import { api } from "./api";
import type { CartItem } from "./cart";

export interface ShippingOption {
  shippingMethodId: string;
  label: string;
  ruleType: string;
  amountEurCents: number;
}

/**
 * Sprint 134: authoritative, non-mutating shipping-options quote - product prices/profiles are
 * always re-read server-side, never trusted from the cart. Advisory only: the final COD
 * submission independently re-resolves shipping inside its own checkout transaction, so a stale
 * quote here can never become the charged amount (see lib/orders.ts's expectedShippingAmountEur).
 */
export function getShippingOptions(items: CartItem[], countryCode?: string): Promise<{ items: ShippingOption[] }> {
  return api.post<{ items: ShippingOption[] }>("/api/orders/shipping-options", {
    items: items.map((item) => ({ productId: item.productId, quantity: 1 as const })),
    ...(countryCode ? { countryCode } : {}),
  });
}
