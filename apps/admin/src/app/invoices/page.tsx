"use client";

import { useEffect, useState } from "react";
import { euro, invoicesApi, mapInvoiceListRow } from "@/lib/erpSalesFinanceBridge";

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    invoicesApi
      .list()
      .then((res) => setInvoices(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load invoices"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main>
      <h1>Invoices</h1>
      <p>
        One Sales Invoice Draft is created automatically for every completed order. Review, edit VAT and totals
        while Draft, then Issue from the invoice detail page.
      </p>
      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading invoices...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && invoices.length === 0 && <p>No invoices found.</p>}

      {!loading && !loadError && invoices.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Invoice</th><th>Order</th><th>Type</th><th>Status</th><th>Subtotal</th><th>VAT</th><th>Total</th><th>Created</th><th>Issued</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((row) => {
              const inv = mapInvoiceListRow(row);
              return (
                <tr key={inv.id}>
                  <td>{inv.label}</td>
                  <td><a href={`/orders/${inv.orderId}`}>{inv.orderId}</a></td>
                  <td>{inv.type}</td>
                  <td>{inv.status}</td>
                  <td>{euro(inv.subtotal)}</td>
                  <td>{euro(inv.taxVatAmount)}</td>
                  <td>{euro(inv.totalAmount)}</td>
                  <td>{inv.createdAt}</td>
                  <td>{inv.issuedAt ?? "—"}</td>
                  <td><a href={inv.href}>View</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
