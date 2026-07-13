"use client";

import { ORDER_STATUS_VALUES, PAYMENT_STATUS_VALUES } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { customerName, listOrders, type OrderWithItems } from "@/lib/orders";

const PAGE_SIZE = 20;

export default function OrdersPage() {
  const [items, setItems] = useState<OrderWithItems[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listOrders({ page, pageSize: PAGE_SIZE, search, status, paymentStatus })
      .then((res) => {
        setItems(res.data);
        setTotal(res.pagination.total);
        setTotalPages(Math.max(1, res.pagination.totalPages));
      })
      .catch((err) => setError(err.message ?? "Failed to load orders"))
      .finally(() => setLoading(false));
  }, [page, search, status, paymentStatus]);

  return (
    <div>
      <h1>Orders</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <input
          placeholder="Search order or email"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          style={inputStyle}
        />
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">All order statuses</option>
          {ORDER_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={paymentStatus}
          onChange={(e) => {
            setPage(1);
            setPaymentStatus(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">All payment statuses</option>
          {PAYMENT_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading orders...</p>}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      {!loading && !error && (
        <div className="noctella-panel" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
                <th style={thStyle}>Order</th>
                <th style={thStyle}>Customer</th>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Order Status</th>
                <th style={thStyle}>Payment Status</th>
                <th style={thStyle}>Provider</th>
                <th style={thStyle}>Total</th>
                <th style={thStyle}>Currency</th>
                <th style={thStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                    No orders found.
                  </td>
                </tr>
              )}
              {items.map((order) => (
                <tr key={order.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                  <td style={tdStyle}>
                    <Link href={`/orders/${order.id}`} style={{ color: "var(--noctella-ivory)" }}>
                      {order.orderNumber}
                    </Link>
                  </td>
                  <td style={tdStyle}>{customerName(order)}</td>
                  <td style={tdStyle}>{order.guestEmail}</td>
                  <td style={tdStyle}>{order.status}</td>
                  <td style={tdStyle}>{order.paymentStatus}</td>
                  <td style={tdStyle}>{order.paymentProvider ?? "—"}</td>
                  <td style={tdStyle}>{order.totalAmount.toFixed(2)}</td>
                  <td style={tdStyle}>{order.currency}</td>
                  <td style={tdStyle}>{new Date(order.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
        <span style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Page {page} of {totalPages} ({total} total)
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={buttonStyle}>
            Previous
          </button>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} style={buttonStyle}>
            Next
          </button>
        </div>
      </div>
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

const buttonStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};
