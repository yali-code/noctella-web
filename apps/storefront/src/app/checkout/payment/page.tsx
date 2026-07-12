"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getCart, isCashOnDeliveryAvailable } from "@/lib/cart";
import { getCheckoutDraft, isCheckoutDraftValid } from "@/lib/checkout";
import { getOrRebuildOrderDraft, type OrderDraft } from "@/lib/orderDraft";
import {
  getPaymentSelectionForDraft,
  savePaymentSelection,
  type PaymentSelectionProvider,
} from "@/lib/paymentSelection";
import { initializeMockPayment } from "@/lib/payments";
import { ApiError } from "@/lib/api";

interface MethodOption {
  provider: PaymentSelectionProvider;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
}

export default function CheckoutPaymentPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [cartEmpty, setCartEmpty] = useState(false);
  const [checkoutInvalid, setCheckoutInvalid] = useState(false);
  const [orderDraft, setOrderDraft] = useState<OrderDraft | null>(null);
  const [methods, setMethods] = useState<MethodOption[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<PaymentSelectionProvider | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cart = getCart();
    if (cart.length === 0) {
      setCartEmpty(true);
      setLoaded(true);
      return;
    }

    const checkoutDraft = getCheckoutDraft();
    if (!isCheckoutDraftValid(checkoutDraft)) {
      setCheckoutInvalid(true);
      setLoaded(true);
      return;
    }

    const draft = getOrRebuildOrderDraft(cart, checkoutDraft);
    if (!draft) {
      setCheckoutInvalid(true);
      setLoaded(true);
      return;
    }
    setOrderDraft(draft);

    const codAvailable = isCashOnDeliveryAvailable(cart);
    setMethods([
      { provider: "stripe", name: "Stripe", description: "Pay securely by card (mock).", available: true },
      { provider: "paypal", name: "PayPal", description: "Pay with your PayPal account (mock).", available: true },
      {
        provider: "cash_on_delivery",
        name: "Cash on Delivery",
        description: "Pay in cash when your order arrives.",
        available: codAvailable,
        unavailableReason: codAvailable ? undefined : "Not available for the items in your cart.",
      },
    ]);

    const existingSelection = getPaymentSelectionForDraft(draft.id);
    if (existingSelection) {
      setSelectedProvider(existingSelection.provider);
    }

    setLoaded(true);
  }, []);

  function handleSelect(provider: PaymentSelectionProvider) {
    if (!orderDraft) return;
    setSelectedProvider(provider);
    savePaymentSelection(orderDraft.id, provider);
  }

  async function handleInitialize() {
    if (!orderDraft || !selectedProvider) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await initializeMockPayment({
        provider: selectedProvider,
        orderDraftId: orderDraft.id,
        amount: orderDraft.currencySummary.eurSubtotal,
        currency: "EUR",
      });
      savePaymentSelection(orderDraft.id, selectedProvider, {
        ...result,
        amount: orderDraft.currencySummary.eurSubtotal,
        currency: "EUR",
      });
      router.push("/checkout/payment/confirm");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!loaded) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <p role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
          Loading...
        </p>
      </section>
    );
  }

  if (cartEmpty) {
    return (
      <section style={{ padding: "60px 40px", textAlign: "center" }}>
        <h1>Payment</h1>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>Your cart is empty.</p>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 16 }}>
          <Link href="/shop" style={{ fontSize: 14 }}>
            Return to Shop
          </Link>
          <Link href="/cart" style={{ fontSize: 14 }}>
            View Cart
          </Link>
        </div>
      </section>
    );
  }

  if (checkoutInvalid || !orderDraft) {
    return (
      <section style={{ padding: "60px 40px", textAlign: "center" }}>
        <h1>Payment</h1>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>
          Your checkout details are missing or incomplete.
        </p>
        <Link href="/checkout" style={{ fontSize: 14 }}>
          Back to Checkout
        </Link>
      </section>
    );
  }

  return (
    <section style={{ padding: "48px 40px", maxWidth: 560 }}>
      <h1>Payment Method</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && (
        <p role="alert" style={{ color: "#c86a6a", marginBottom: 16 }}>
          {error}
        </p>
      )}

      <fieldset style={{ border: "1px solid var(--noctella-antique-gold)", borderRadius: 4, padding: 20 }}>
        <legend style={{ padding: "0 8px", color: "var(--noctella-bright-star-gold)", fontFamily: "var(--font-display)" }}>
          Choose a payment method
        </legend>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {methods.map((method) => (
            <label
              key={method.provider}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: 12,
                border: "1px solid var(--noctella-aged-bronze)",
                borderRadius: 4,
                opacity: method.available ? 1 : 0.5,
                cursor: method.available ? "pointer" : "not-allowed",
              }}
            >
              <input
                type="radio"
                name="paymentMethod"
                value={method.provider}
                checked={selectedProvider === method.provider}
                disabled={!method.available}
                onChange={() => handleSelect(method.provider)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ display: "block", fontSize: 15 }}>{method.name}</span>
                <span style={{ display: "block", fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
                  {method.description}
                </span>
                {!method.available && method.unavailableReason && (
                  <span style={{ display: "block", fontSize: 12, color: "#c86a6a", marginTop: 4 }}>
                    {method.unavailableReason}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        onClick={handleInitialize}
        disabled={!selectedProvider || submitting}
        style={{ ...primaryButtonStyle, marginTop: 24 }}
      >
        {submitting ? "Initializing..." : "Initialize Mock Payment"}
      </button>

      <p style={{ marginTop: 16 }}>
        <Link href="/checkout/review" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Back to Review
        </Link>
      </p>
    </section>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
