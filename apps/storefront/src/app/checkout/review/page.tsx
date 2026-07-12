"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCart } from "@/lib/cart";
import { getCheckoutDraft, isCheckoutDraftValid, type Address } from "@/lib/checkout";
import { getOrRebuildOrderDraft, type OrderDraft } from "@/lib/orderDraft";

function formatAddress(address: Address): string {
  return [address.line1, address.line2, [address.city, address.state].filter(Boolean).join(", "), address.postalCode]
    .filter(Boolean)
    .join(", ");
}

export default function CheckoutReviewPage() {
  const [loaded, setLoaded] = useState(false);
  const [cartEmpty, setCartEmpty] = useState(false);
  const [checkoutInvalid, setCheckoutInvalid] = useState(false);
  const [draft, setDraft] = useState<OrderDraft | null>(null);

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

    setDraft(getOrRebuildOrderDraft(cart, checkoutDraft));
    setLoaded(true);
  }, []);

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
        <h1>Review Order</h1>
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

  if (checkoutInvalid || !draft) {
    return (
      <section style={{ padding: "60px 40px", textAlign: "center" }}>
        <h1>Review Order</h1>
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
    <section style={{ padding: "48px 40px" }}>
      <h1>Review Order</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 24 }}>
          <ReviewSection title="Customer" editHref="/checkout">
            <Row label="Email" value={draft.customer.email} />
            {draft.customer.phone && <Row label="Phone" value={draft.customer.phone} />}
            <Row label="First Name" value={draft.customer.firstName} />
            <Row label="Last Name" value={draft.customer.lastName} />
            {draft.customer.company && <Row label="Company" value={draft.customer.company} />}
          </ReviewSection>

          <ReviewSection title="Shipping Address" editHref="/checkout">
            <Row label="Address" value={formatAddress(draft.shippingAddress)} />
            <Row label="Country" value={draft.shippingAddress.country} />
            <Row label="Country Code" value={draft.shippingAddress.countryCode} />
          </ReviewSection>

          <ReviewSection title="Billing Address" editHref="/checkout">
            {draft.billingSameAsShipping ? (
              <p style={{ margin: 0, fontSize: 14 }}>Same as shipping</p>
            ) : (
              draft.billingAddress && (
                <>
                  <Row label="Address" value={formatAddress(draft.billingAddress)} />
                  <Row label="Country" value={draft.billingAddress.country} />
                  <Row label="Country Code" value={draft.billingAddress.countryCode} />
                </>
              )
            )}
          </ReviewSection>

          {draft.customerNote && (
            <ReviewSection title="Order Note" editHref="/checkout">
              <p style={{ margin: 0, fontSize: 14 }}>{draft.customerNote}</p>
            </ReviewSection>
          )}
        </div>

        <aside style={{ flex: "1 1 320px" }}>
          <div className="noctella-panel" style={{ padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Order Summary</h3>
              <Link href="/cart" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
                Edit cart
              </Link>
            </div>

            {draft.items.map((item) => (
              <div
                key={item.productId}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  padding: "10px 0",
                  borderBottom: "1px solid rgba(122,106,79,0.3)",
                }}
              >
                {item.primaryImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.primaryImageUrl}
                    alt={item.title}
                    style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4 }}
                  />
                ) : (
                  <div style={{ width: 48, height: 48, borderRadius: 4, background: "var(--noctella-night-navy)" }} />
                )}
                <div style={{ flex: 1, fontSize: 13 }}>
                  <p style={{ margin: 0 }}>{item.title}</p>
                  <p style={{ margin: "2px 0 0", color: "var(--noctella-aged-bronze)" }}>Qty: {item.quantity}</p>
                </div>
                <div style={{ fontSize: 13, textAlign: "right" }}>
                  <p style={{ margin: 0 }}>€{item.eurPrice.toFixed(2)}</p>
                  {item.usdPrice !== undefined && (
                    <p style={{ margin: 0, color: "var(--noctella-aged-bronze)" }}>${item.usdPrice.toFixed(2)}</p>
                  )}
                </div>
              </div>
            ))}

            <div style={{ marginTop: 16, fontSize: 14 }}>
              <SummaryRow label="EUR Subtotal" value={`€${draft.currencySummary.eurSubtotal.toFixed(2)}`} />
              {draft.currencySummary.usdSubtotal !== undefined && (
                <SummaryRow label="USD Subtotal" value={`$${draft.currencySummary.usdSubtotal.toFixed(2)}`} />
              )}
              <SummaryRow label="Shipping" value="Calculated later" muted />
              <SummaryRow label="Taxes / Duties" value="Not included" muted />
              <hr className="noctella-divider" style={{ margin: "10px 0" }} />
              <SummaryRow
                label="Total"
                value={`€${draft.currencySummary.eurSubtotal.toFixed(2)} (cart subtotal only)`}
              />
            </div>

            <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)", marginTop: 16 }}>
              Buyers are responsible for any customs duties, import taxes, or local charges that may
              occur during international shipping.
            </p>

            <Link
              href="/checkout/payment"
              style={{ ...primaryButtonStyle, display: "block", textAlign: "center", textDecoration: "none" }}
            >
              Continue to Payment
            </Link>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ReviewSection({
  title,
  editHref,
  children,
}: {
  title: string;
  editHref: string;
  children: React.ReactNode;
}) {
  return (
    <div className="noctella-panel" style={{ padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
        <Link href={editHref} style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Edit
        </Link>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function SummaryRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
      <span style={{ color: muted ? "var(--noctella-aged-bronze)" : "var(--noctella-ivory)" }}>{label}</span>
      <span style={{ color: muted ? "var(--noctella-aged-bronze)" : "var(--noctella-ivory)" }}>{value}</span>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 16,
  padding: "12px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
