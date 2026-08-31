"use client";

import { useCallback, useEffect, useState } from "react";
import { getCart, removeFromCartPersisted, replaceCartPersisted, type CartItem } from "@/lib/cart";
import { reconcileCart, type CartReconciliationResult } from "@/lib/cartReconciliation";

export interface CartFreshnessState {
  items: CartItem[];
  loading: boolean;
  error: boolean;
  result: CartReconciliationResult | null;
  canProceed: boolean;
  reconcileNow: () => Promise<{ canProceed: boolean; items: CartItem[] }>;
  acceptChanges: () => void;
  removeUnavailable: (productId: string) => void;
  retry: () => void;
}

export function useCartFreshness(): CartFreshnessState {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<CartReconciliationResult | null>(null);

  const run = useCallback(async (source = getCart()) => {
    setLoading(true);
    setError(false);
    try {
      const next = await reconcileCart(source);
      setResult(next);
      const needsReview = next.changes.length > 0;
      const hasUnavailable = next.unavailableItems.length > 0;
      if (!needsReview) {
        replaceCartPersisted(next.currentItems);
        setItems(next.currentItems);
        window.dispatchEvent(new Event("noctella:cart-updated"));
      } else {
        // Keep the accepted/persisted snapshot until the customer reviews the commerce change.
        setItems(source);
      }
      setLoading(false);
      return { canProceed: !needsReview && !hasUnavailable, items: needsReview ? source : next.currentItems };
    } catch {
      setItems(source);
      setResult(null);
      setError(true);
      setLoading(false);
      return { canProceed: false, items: source };
    }
  }, []);

  useEffect(() => { void run(); }, [run]);

  const acceptChanges = useCallback(() => {
    if (!result) return;
    replaceCartPersisted(result.currentItems);
    setItems(result.currentItems);
    setResult({ ...result, previousItems: result.currentItems, changes: [] });
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }, [result]);

  const removeUnavailable = useCallback((productId: string) => {
    const updated = removeFromCartPersisted(productId);
    setItems(updated);
    void run(updated);
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }, [run]);

  const hasChanges = (result?.changes.length ?? 0) > 0;
  const hasUnavailable = (result?.unavailableItems.length ?? 0) > 0;
  return {
    items,
    loading,
    error,
    result,
    canProceed: !loading && !error && !hasChanges && !hasUnavailable,
    reconcileNow: () => run(getCart()),
    acceptChanges,
    removeUnavailable,
    retry: () => { void run(getCart()); },
  };
}

export function CartFreshnessBlocker({ freshness, title }: { freshness: CartFreshnessState; title: string }) {
  if (freshness.canProceed) return null;
  return (
    <section style={{ padding: "clamp(40px, 8vw, 60px) clamp(20px, 6vw, 40px)", maxWidth: 720 }}>
      <h1>{title}</h1>
      {freshness.loading && <p role="status">Checking your cart...</p>}
      {freshness.error && (
        <div role="alert">
          <p>We could not refresh your cart. Please check your connection and try again.</p>
          <button type="button" onClick={freshness.retry}>Retry cart check</button>
        </div>
      )}
      {(freshness.result?.changes.length ?? 0) > 0 && (
        <div role="alert">
          <h2>Your cart changed</h2>
          {freshness.result!.changes.map((change) => (
            <div key={change.productId}>
              <p><strong>{change.title}</strong></p>
              {change.previousPriceEur !== undefined && change.currentPriceEur !== undefined && (
                <p>Price changed from €{change.previousPriceEur.toFixed(2)} to €{change.currentPriceEur.toFixed(2)}.</p>
              )}
              {change.codEligibilityChanged && <p>Cash on Delivery availability changed for this item.</p>}
            </div>
          ))}
          <button type="button" onClick={freshness.acceptChanges}>Review updated cart</button>
        </div>
      )}
      {(freshness.result?.unavailableItems.length ?? 0) > 0 && (
        <div role="alert">
          <h2>Items need attention</h2>
          {freshness.result!.unavailableItems.map((item) => (
            <div key={item.productId}>
              <p><strong>{item.title}</strong> is {item.reason === "out_of_stock" ? "out of stock" : "no longer available"}.</p>
              <button type="button" onClick={() => freshness.removeUnavailable(item.productId)}>Remove {item.title}</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
