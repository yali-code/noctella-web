import { api } from "./api";
import type { CartItem } from "./cart";

export type ReconciledCartLine =
  | { productId: string; availability: "unavailable"; reason: "unavailable" | "out_of_stock" }
  | {
      productId: string;
      availability: "available";
      slug: string;
      title: string;
      primaryImageUrl?: string;
      priceEur: number;
      priceUsd?: number;
      productType: string;
      allowCashOnDelivery: boolean;
    };

export interface CartCommerceChange {
  productId: string;
  title: string;
  previousPriceEur?: number;
  currentPriceEur?: number;
  codEligibilityChanged: boolean;
}

export interface CartReconciliationResult {
  previousItems: CartItem[];
  currentItems: CartItem[];
  changes: CartCommerceChange[];
  unavailableItems: Array<{ productId: string; title: string; reason: "unavailable" | "out_of_stock" }>;
}

const cents = (amount: number) => Math.round((amount + Number.EPSILON) * 100);

export function buildCartReconciliation(
  previousItems: CartItem[],
  response: { items: ReconciledCartLine[] },
): CartReconciliationResult {
  const byId = new Map(response.items.map((item) => [item.productId, item]));
  const changes: CartCommerceChange[] = [];
  const unavailableItems: CartReconciliationResult["unavailableItems"] = [];

  const currentItems = previousItems.map((previous) => {
    const current = byId.get(previous.productId);
    if (!current || current.availability === "unavailable") {
      unavailableItems.push({
        productId: previous.productId,
        title: previous.title,
        reason: current?.reason ?? "unavailable",
      });
      return previous;
    }

    const priceChanged = cents(previous.eurPrice) !== cents(current.priceEur);
    const codEligibilityChanged = previous.allowCashOnDelivery !== current.allowCashOnDelivery;
    if (priceChanged || codEligibilityChanged) {
      changes.push({
        productId: previous.productId,
        title: current.title,
        previousPriceEur: priceChanged ? previous.eurPrice : undefined,
        currentPriceEur: priceChanged ? current.priceEur : undefined,
        codEligibilityChanged,
      });
    }

    return {
      productId: current.productId,
      slug: current.slug,
      title: current.title,
      primaryImageUrl: current.primaryImageUrl,
      eurPrice: current.priceEur,
      usdPrice: current.priceUsd,
      quantity: 1,
      productType: current.productType,
      allowCashOnDelivery: current.allowCashOnDelivery,
    };
  });

  return { previousItems, currentItems, changes, unavailableItems };
}

export async function reconcileCart(items: CartItem[]): Promise<CartReconciliationResult> {
  if (items.length === 0) return { previousItems: [], currentItems: [], changes: [], unavailableItems: [] };
  const response = await api.post<{ items: ReconciledCartLine[] }>("/api/public/products/reconcile", {
    items: items.map((item) => ({ productId: item.productId, quantity: 1 as const })),
  });
  return buildCartReconciliation(items, response);
}
