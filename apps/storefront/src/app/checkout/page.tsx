"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type CartItem, cartEurSubtotal, cartUsdSubtotal, getCart } from "@/lib/cart";
import {
  type Address,
  type CheckoutDraft,
  type CheckoutFormErrors,
  SUPPORTED_COUNTRIES,
  emptyAddress,
  emptyCheckoutDraft,
  getCheckoutDraft,
  saveCheckoutDraft,
  validateCheckoutDraft,
} from "@/lib/checkout";

export default function CheckoutPage() {
  const router = useRouter();
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartLoaded, setCartLoaded] = useState(false);
  const [draft, setDraft] = useState<CheckoutDraft>(emptyCheckoutDraft);
  const [errors, setErrors] = useState<CheckoutFormErrors>({});

  useEffect(() => {
    setCartItems(getCart());
    setCartLoaded(true);
    setDraft(getCheckoutDraft());
  }, []);

  function updateContact(field: "email" | "phone", value: string) {
    setDraft((prev) => ({ ...prev, contact: { ...prev.contact, [field]: value } }));
  }

  function updateCustomer(field: "firstName" | "lastName" | "company", value: string) {
    setDraft((prev) => ({ ...prev, customer: { ...prev.customer, [field]: value } }));
  }

  function updateShipping(field: keyof Address, value: string) {
    setDraft((prev) => ({ ...prev, shippingAddress: { ...prev.shippingAddress, [field]: value } }));
  }

  function updateBilling(field: keyof Address, value: string) {
    setDraft((prev) => ({
      ...prev,
      billingAddress: { ...(prev.billingAddress ?? emptyAddress), [field]: value },
    }));
  }

  function toggleBillingSameAsShipping(checked: boolean) {
    setDraft((prev) => ({ ...prev, billingSameAsShipping: checked }));
  }

  function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    const validationErrors = validateCheckoutDraft(draft);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    saveCheckoutDraft(draft);
    router.push("/checkout/review");
  }

  const eurSubtotal = cartEurSubtotal(cartItems);
  const usdSubtotal = cartUsdSubtotal(cartItems);

  if (cartLoaded && cartItems.length === 0) {
    return (
      <section style={{ padding: "60px 40px", textAlign: "center" }}>
        <h1>Checkout</h1>
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

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>Checkout</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
        <form onSubmit={handleContinue} style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 28 }}>
          <Section title="Contact">
            <Field label="Email" error={errors.email}>
              <input
                type="email"
                value={draft.contact.email}
                onChange={(e) => updateContact("email", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Phone (optional)">
              <input
                type="tel"
                value={draft.contact.phone ?? ""}
                onChange={(e) => updateContact("phone", e.target.value)}
                style={inputStyle}
              />
            </Field>
          </Section>

          <Section title="Customer">
            <Field label="First Name" error={errors.firstName}>
              <input
                value={draft.customer.firstName}
                onChange={(e) => updateCustomer("firstName", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Last Name" error={errors.lastName}>
              <input
                value={draft.customer.lastName}
                onChange={(e) => updateCustomer("lastName", e.target.value)}
                style={inputStyle}
              />
            </Field>
            <Field label="Company (optional)">
              <input
                value={draft.customer.company ?? ""}
                onChange={(e) => updateCustomer("company", e.target.value)}
                style={inputStyle}
              />
            </Field>
          </Section>

          <Section title="Shipping Address">
            <AddressFields address={draft.shippingAddress} errors={errors.shippingAddress} onChange={updateShipping} />
          </Section>

          <Section title="Billing">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={draft.billingSameAsShipping}
                onChange={(e) => toggleBillingSameAsShipping(e.target.checked)}
              />
              Billing address same as shipping
            </label>
            {!draft.billingSameAsShipping && (
              <AddressFields
                address={draft.billingAddress ?? emptyAddress}
                errors={errors.billingAddress}
                onChange={updateBilling}
              />
            )}
          </Section>

          <Section title="Order Notes">
            <Field label="Note (optional)">
              <textarea
                value={draft.customerNote ?? ""}
                onChange={(e) => setDraft((prev) => ({ ...prev, customerNote: e.target.value }))}
                style={{ ...inputStyle, minHeight: 70 }}
              />
            </Field>
          </Section>

          <button type="submit" style={primaryButtonStyle}>
            Continue to Review
          </button>
        </form>

        <aside style={{ flex: "1 1 320px" }}>
          <div className="noctella-panel" style={{ padding: 20 }}>
            <h3 style={{ marginTop: 0 }}>Order Summary</h3>
            {cartItems.map((item) => (
              <div key={item.productId} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
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
              <SummaryRow label="EUR Subtotal" value={`€${eurSubtotal.toFixed(2)}`} />
              {usdSubtotal !== undefined && (
                <SummaryRow label="USD Subtotal" value={`$${usdSubtotal.toFixed(2)}`} />
              )}
              <SummaryRow label="Shipping" value="Calculated later" muted />
              <SummaryRow label="Taxes / Duties" value="Not included" muted />
              <hr className="noctella-divider" style={{ margin: "10px 0" }} />
              <SummaryRow label="Total" value={`€${eurSubtotal.toFixed(2)} (cart subtotal only)`} />
            </div>

            <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)", marginTop: 16 }}>
              Buyers are responsible for any customs duties, import taxes, or local charges that may
              occur during international shipping.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid var(--noctella-antique-gold)", borderRadius: 4, padding: 20 }}>
      <legend style={{ padding: "0 8px", color: "var(--noctella-bright-star-gold)", fontFamily: "var(--font-display)" }}>
        {title}
      </legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
    </fieldset>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      {children}
      {error && <span style={{ color: "#c86a6a", fontSize: 12 }}>{error}</span>}
    </label>
  );
}

function AddressFields({
  address,
  errors,
  onChange,
}: {
  address: Address;
  errors?: { line1?: string; city?: string; postalCode?: string; country?: string; countryCode?: string };
  onChange: (field: keyof Address, value: string) => void;
}) {
  return (
    <>
      <Field label="Address Line 1" error={errors?.line1}>
        <input value={address.line1} onChange={(e) => onChange("line1", e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Address Line 2 (optional)">
        <input value={address.line2 ?? ""} onChange={(e) => onChange("line2", e.target.value)} style={inputStyle} />
      </Field>
      <Field label="City" error={errors?.city}>
        <input value={address.city} onChange={(e) => onChange("city", e.target.value)} style={inputStyle} />
      </Field>
      <Field label="State / Province (optional)">
        <input value={address.state ?? ""} onChange={(e) => onChange("state", e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Postal Code" error={errors?.postalCode}>
        <input value={address.postalCode} onChange={(e) => onChange("postalCode", e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Country" error={errors?.country || errors?.countryCode}>
        <select
          value={address.countryCode}
          onChange={(e) => {
            const selected = SUPPORTED_COUNTRIES.find((c) => c.code === e.target.value);
            onChange("countryCode", e.target.value);
            onChange("country", selected?.name ?? "");
          }}
          style={inputStyle}
        >
          <option value="">Select a country</option>
          {SUPPORTED_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
    </>
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

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-night-navy)",
  border: "1px solid var(--noctella-aged-bronze)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "12px 28px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
