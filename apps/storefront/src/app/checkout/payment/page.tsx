"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getCart, isCashOnDeliveryAvailable } from "@/lib/cart";
import { getCheckoutDraft, isCheckoutDraftValid } from "@/lib/checkout";
import { getOrRebuildOrderDraft, type OrderDraft } from "@/lib/orderDraft";
import { createCashOnDeliveryOrder, saveCreatedOrder } from "@/lib/orders";
import { ApiError } from "@/lib/api";

export default function CheckoutPaymentPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [cartEmpty, setCartEmpty] = useState(false);
  const [checkoutInvalid, setCheckoutInvalid] = useState(false);
  const [orderDraft, setOrderDraft] = useState<OrderDraft | null>(null);
  const [codAvailable, setCodAvailable] = useState(false);
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

    setCodAvailable(isCashOnDeliveryAvailable(cart));

    setLoaded(true);
  }, []);

  async function handleSubmit() {
    if (!orderDraft || !codAvailable || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const order = await createCashOnDeliveryOrder(orderDraft);
      saveCreatedOrder(order);
      router.push("/checkout/success");
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
          Launch payment method
        </legend>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: 12,
                border: "1px solid var(--noctella-aged-bronze)",
                borderRadius: 4,
                opacity: codAvailable ? 1 : 0.5,
                cursor: codAvailable ? "default" : "not-allowed",
              }}
            >
              <input
                type="radio"
                name="paymentMethod"
                value="cash_on_delivery"
                checked
                disabled
                readOnly
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ display: "block", fontSize: 15 }}>Cash on Delivery</span>
                <span style={{ display: "block", fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
                  Pay when your order arrives.
                </span>
                {!codAvailable && (
                  <span style={{ display: "block", fontSize: 12, color: "#c86a6a", marginTop: 4 }}>
                    Not available for the items in your cart.
                  </span>
                )}
              </span>
            </label>
        </div>
      </fieldset>

      <button
        onClick={handleSubmit}
        disabled={!codAvailable || submitting}
        style={{ ...primaryButtonStyle, marginTop: 24 }}
      >
        {submitting ? "Placing order..." : "Place Cash on Delivery Order"}
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
