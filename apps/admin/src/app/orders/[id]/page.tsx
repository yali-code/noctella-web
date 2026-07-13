"use client";

import { ORDER_STATUS_VALUES } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getOrder, updateOrderStatus, type OrderWithItems } from "@/lib/orders";

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const [order, setOrder] = useState<OrderWithItems | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getOrder(params.id)
      .then((loaded) => {
        setOrder(loaded);
        setStatus(loaded.status);
      })
      .catch((err) => setError(err.message ?? "Failed to load order"))
      .finally(() => setLoading(false));
  }, [params.id]);

  async function handleStatusUpdate() {
    if (!order) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateOrderStatus(order.id, status);
      setOrder(updated);
      setStatus(updated.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading order...</p>;

  if (error && !order) {
    return (
      <div>
        <h1>Order</h1>
        <p style={{ color: "#c86a6a" }}>{error}</p>
        <Link href="/orders">Back to Orders</Link>
      </div>
    );
  }

  if (!order) return null;

  return (
    <div>
      <Link href="/orders" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
        ← Back to Orders
      </Link>
      <h1>{order.orderNumber}</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Customer / Contact</h3>
          <Row label="Name" value={order.shippingAddress.fullName || order.billingAddress.fullName} />
          <Row label="Email" value={order.guestEmail} />
          {order.shippingAddress.phone && <Row label="Phone" value={order.shippingAddress.phone} />}
          {order.notes && <Row label="Customer Note" value={order.notes} />}
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Shipping Address</h3>
          <AddressRows address={order.shippingAddress} />
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Billing Address</h3>
          <AddressRows address={order.billingAddress} />
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Payment</h3>
          <Row label="Provider" value={order.paymentProvider ?? "—"} />
          <Row label="Status" value={order.paymentStatus} />
          <Row label="Reference" value={order.paymentReference ?? "—"} />
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Order Status</h3>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            {ORDER_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button disabled={saving || status === order.status} onClick={handleStatusUpdate} style={buttonStyle}>
            {saving ? "Saving..." : "Update Status"}
          </button>
        </section>

        <section className="noctella-panel" style={{ padding: 20 }}>
          <h3>Totals</h3>
          <Row label="Subtotal" value={order.subtotalAmount.toFixed(2)} />
          <Row label="Shipping" value={order.shippingAmount.toFixed(2)} />
          <Row label="Tax" value={order.taxAmount.toFixed(2)} />
          <Row label="Total" value={order.totalAmount.toFixed(2)} />
          <Row label="Currency" value={order.currency} />
          <Row label="Created" value={new Date(order.createdAt).toLocaleString()} />
          <Row label="Updated" value={new Date(order.updatedAt).toLocaleString()} />
        </section>
      </div>

      <section className="noctella-panel" style={{ padding: 20, marginTop: 20, overflowX: "auto" }}>
        <h3>Order Items</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={thStyle}>Image</th>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>Slug</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Unit</th>
              <th style={thStyle}>Line Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>
                  {item.productImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.productImageUrl} alt="" style={{ width: 44, height: 44, objectFit: "cover" }} />
                  ) : (
                    "—"
                  )}
                </td>
                <td style={tdStyle}>{item.productTitle}</td>
                <td style={tdStyle}>{item.productSlug}</td>
                <td style={tdStyle}>{item.productType}</td>
                <td style={tdStyle}>{item.quantity}</td>
                <td style={tdStyle}>{item.unitPrice.toFixed(2)}</td>
                <td style={tdStyle}>{item.totalPrice.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function AddressRows({ address }: { address: OrderWithItems["shippingAddress"] }) {
  return (
    <>
      <Row label="Name" value={address.fullName} />
      <Row label="Line 1" value={address.line1} />
      {address.line2 && <Row label="Line 2" value={address.line2} />}
      <Row label="City" value={address.city} />
      {address.region && <Row label="Region" value={address.region} />}
      <Row label="Postal Code" value={address.postalCode} />
      <Row label="Country" value={address.country} />
    </>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value || "—"}</span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
};

const buttonStyle: React.CSSProperties = {
  ...inputStyle,
  marginLeft: 8,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--noctella-bright-star-gold)",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
};
