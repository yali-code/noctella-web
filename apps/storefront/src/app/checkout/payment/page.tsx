"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getCart, isCashOnDeliveryAvailable } from "@/lib/cart";
import { getCheckoutDraft, isCheckoutDraftValid } from "@/lib/checkout";
import { getOrRebuildOrderDraft, type OrderDraft } from "@/lib/orderDraft";
import { createCashOnDeliveryOrder, saveCreatedOrder } from "@/lib/orders";
import { getShippingOptions, type ShippingOption } from "@/lib/shipping";
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

  const [shippingLoading, setShippingLoading] = useState(false);
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([]);
  const [shippingError, setShippingError] = useState(false);
  const [selectedShippingMethodId, setSelectedShippingMethodId] = useState<string | null>(null);

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

    setShippingLoading(true);
    getShippingOptions(cart, checkoutDraft.shippingAddress.countryCode)
      .then((result) => {
        setShippingOptions(result.items);
        // Sprint 134: safe to preselect only when exactly one method is eligible - never guesses among multiple.
        setSelectedShippingMethodId(result.items.length === 1 ? result.items[0].shippingMethodId : null);
      })
      .catch(() => setShippingError(true))
      .finally(() => setShippingLoading(false));
  }, []);

  const selectedOption = shippingOptions.find((option) => option.shippingMethodId === selectedShippingMethodId) ?? null;
  const shippingReady = !shippingLoading && !shippingError && selectedOption !== null;
  const subtotalEur = orderDraft?.currencySummary.eurSubtotal ?? 0;
  const totalEur = selectedOption ? subtotalEur + selectedOption.amountEurCents / 100 : subtotalEur;

  async function handleSubmit() {
    if (!orderDraft || !codAvailable || !selectedOption || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const order = await createCashOnDeliveryOrder(orderDraft, {
        shippingMethodId: selectedOption.shippingMethodId,
        expectedShippingAmountEur: selectedOption.amountEurCents / 100,
      });
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

      <fieldset style={{ border: "1px solid var(--noctella-antique-gold)", borderRadius: 4, padding: 20, marginTop: 20 }}>
        <legend style={{ padding: "0 8px", color: "var(--noctella-bright-star-gold)", fontFamily: "var(--font-display)" }}>
          Shipping
        </legend>

        {shippingLoading && (
          <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
            Calculating shipping...
          </p>
        )}

        {!shippingLoading && shippingError && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: "#c86a6a" }}>
            Shipping could not be calculated. Please try again.
          </p>
        )}

        {!shippingLoading && !shippingError && shippingOptions.length === 0 && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: "#c86a6a" }}>
            No shipping method is available for your destination and cart.
          </p>
        )}

        {!shippingLoading && !shippingError && shippingOptions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {shippingOptions.map((option) => (
              <label
                key={option.shippingMethodId}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, border: "1px solid var(--noctella-aged-bronze)", borderRadius: 4, cursor: "pointer" }}
              >
                <input
                  type="radio"
                  name="shippingMethod"
                  value={option.shippingMethodId}
                  checked={selectedShippingMethodId === option.shippingMethodId}
                  onChange={() => setSelectedShippingMethodId(option.shippingMethodId)}
                />
                <span style={{ flex: 1, fontSize: 14 }}>{option.label}</span>
                <span style={{ fontSize: 14 }}>{option.amountEurCents === 0 ? "Free" : `€${(option.amountEurCents / 100).toFixed(2)}`}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div style={{ marginTop: 20, fontSize: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span style={{ color: "var(--noctella-aged-bronze)" }}>Subtotal</span>
          <span>€{subtotalEur.toFixed(2)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span style={{ color: "var(--noctella-aged-bronze)" }}>Shipping</span>
          <span>{selectedOption ? (selectedOption.amountEurCents === 0 ? "Free" : `€${(selectedOption.amountEurCents / 100).toFixed(2)}`) : "—"}</span>
        </div>
        <hr className="noctella-divider" style={{ margin: "8px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontWeight: 600 }}>
          <span>Total</span>
          <span>€{totalEur.toFixed(2)}</span>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!codAvailable || !shippingReady || submitting}
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
