"use client";

import { PAYMENT_PROVIDER_VALUES, PAYMENT_STATUS_VALUES } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { listPaymentSessions, type PaymentSessionRow } from "@/lib/payments";

export default function PaymentsPage() {
  const [items, setItems] = useState<PaymentSessionRow[]>([]);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listPaymentSessions({ status: status || undefined, provider: provider || undefined })
      .then(setItems)
      .catch((err) => setError(err.message ?? "Failed to load payments"))
      .finally(() => setLoading(false));
  }, [status, provider]);

  return (
    <div>
      <h1>Payments</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle}>
          <option value="">All providers</option>
          {PAYMENT_PROVIDER_VALUES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
          <option value="">All statuses</option>
          {PAYMENT_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading payments...</p>}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      {!loading && !error && (
        <div className="noctella-panel" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
                <th style={thStyle}>Provider</th>
                <th style={thStyle}>Reference</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Amount</th>
                <th style={thStyle}>Currency</th>
                <th style={thStyle}>Order</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                    No payments found.
                  </td>
                </tr>
              )}
              {items.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                  <td style={tdStyle}>{p.provider}</td>
                  <td style={tdStyle}>{p.providerReference}</td>
                  <td style={tdStyle}>{p.status}</td>
                  <td style={tdStyle}>{p.amount.toFixed(2)}</td>
                  <td style={tdStyle}>{p.currency}</td>
                  <td style={tdStyle}>
                    {p.orderId ? <Link href={`/orders/${p.orderId}`}>{p.orderId}</Link> : "—"}
                  </td>
                  <td style={tdStyle}>{new Date(p.createdAt).toLocaleString()}</td>
                  <td style={tdStyle}>{new Date(p.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--noctella-bright-star-gold)",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
};
