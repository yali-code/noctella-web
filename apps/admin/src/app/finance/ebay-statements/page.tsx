"use client";

import { useCallback, useEffect, useState } from "react";

interface Order {
  orderNumber: string; transactionId: string; date: string; title: string; customLabel: string | null; shipToCountry: string | null;
  salesUsd: number; salesEur: number; orderFeesUsd: number; adFeesUsd: number; earningsEur: number; earningsAfterRefundEur: number; fundsStatus: string;
}
interface Preview {
  seller: string | null; periodStart: string | null; periodEnd: string | null; rowCounts: Record<string, number>; orders: Order[];
  monthlyFees: Array<{ date: string; description: string; referenceId: string; usd: number; eur: number }>;
  refunds: Array<{ date: string; orderNumber: string; title: string; grossUsd: number; netEur: number; parentOrderInFile: boolean }>;
  totals: { salesUsd: number; salesEur: number; itemSubtotalUsd: number; shippingUsd: number; ebayCollectedTaxUsd: number; orderFeesUsd: number; adFeesUsd: number; monthlyFeesUsd: number; totalFeesUsd: number; feeRatePercent: number; refundsNetEur: number; netRemainingEur: number; payoutsEur: number };
  warnings: string[];
}

interface Month {
  month: string; orderCount: number; unmatchedOrderCount: number; salesUsd: number; salesEur: number; totalFeesUsd: number; feeRatePercent: number;
  refundsNetEur: number; netRemainingEur: number; payoutsEur: number; euSalesEur: number; provisionalEuVatEur: number;
}
interface ImportResult { inserted: number; updated: number; unchanged: number; skippedTypes: string[] }

const cell: React.CSSProperties = { padding: "5px 8px", borderBottom: "1px solid var(--noctella-antique-gold)", textAlign: "left", fontSize: 13 };
const number = (value: number) => value.toFixed(2);
const FUNDS: Record<string, string> = { paid_out: "Paid out", on_hold: "On hold", awaiting_payout: "Awaiting payout" };

/** Reads a report, then saves it to the eBay finance records on request. Stock never changes here. */
export default function EbayStatementsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [months, setMonths] = useState<Month[]>([]);
  const [saved, setSaved] = useState<ImportResult | null>(null);

  const loadMonths = useCallback(async () => {
    const res = await fetch("/api/erp/ebay-statements/months");
    if (!res.ok) throw new Error("Monthly records could not be loaded");
    setMonths(((await res.json()) as { months: Month[] }).months);
  }, []);

  useEffect(() => {
    loadMonths().catch((err) => setError(err instanceof Error ? err.message : "Monthly records could not be loaded"));
  }, [loadMonths]);

  async function handleSave() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/erp/ebay-statements/import", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "The report could not be saved");
      setSaved(body as ImportResult);
      await loadMonths();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setSaved(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/erp/ebay-statements/preview", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "The report could not be read");
      setPreview(body as Preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report could not be read");
    } finally {
      setBusy(false);
    }
  }

  const totals = preview?.totals;
  return (
    <main>
      <h1>eBay Statements</h1>
      <p>Preview first, then save to the finance records. Saving the same report again creates no duplicates. Stock does not change.</p>
      <label>
        Transaction report (CSV, 5 MB max){" "}
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>{" "}
      <button type="button" disabled={!file || busy} onClick={handlePreview}>{busy ? "Reading..." : "Preview"}</button>
      {error && <p role="alert" style={{ color: "#c86a6a" }}>{error}</p>}
      {months.length > 0 && (
        <>
          <h2>Saved months</h2>
          <p>EU VAT is provisional and not accountant-approved: EU sales × 20/120, at eBay rates. Fees may include VAT.</p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse" }}>
              <thead><tr>{["Month", "Orders", "No SKU", "Sales USD", "Sales EUR", "Total fees USD", "Fee rate", "Refunds EUR", "Net remaining EUR", "Payouts EUR", "EU sales EUR", "EU VAT EUR"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <td style={cell}>{m.month}</td><td style={cell}>{m.orderCount}</td><td style={cell}>{m.unmatchedOrderCount}</td><td style={cell}>{number(m.salesUsd)}</td><td style={cell}>{number(m.salesEur)}</td><td style={cell}>{number(m.totalFeesUsd)}</td><td style={cell}>{m.feeRatePercent}%</td><td style={cell}>{number(m.refundsNetEur)}</td><td style={cell}>{number(m.netRemainingEur)}</td><td style={cell}>{number(m.payoutsEur)}</td><td style={cell}>{number(m.euSalesEur)}</td><td style={cell}>{number(m.provisionalEuVatEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {preview && totals && (
        <>
          <p>
            <button type="button" disabled={busy} onClick={handleSave}>{busy ? "Saving..." : "Save to finance records"}</button>
            {saved && <> New: {saved.inserted} · Updated: {saved.updated} · Unchanged: {saved.unchanged}{saved.skippedTypes.length ? ` · Not saved: ${saved.skippedTypes.join(", ")}` : ""}</>}
          </p>
          <h2>{preview.seller} · {preview.periodStart} to {preview.periodEnd}</h2>
          <p>{Object.entries(preview.rowCounts).map(([type, count]) => `${type}: ${count}`).join(" · ")}</p>
          <table style={{ borderCollapse: "collapse", marginBottom: 16 }}>
            <tbody>
              {([
                ["Sales incl. shipping, USD", number(totals.salesUsd)],
                ["Sales incl. shipping, EUR at eBay rates", number(totals.salesEur)],
                ["Item subtotal, USD", number(totals.itemSubtotalUsd)],
                ["Buyer-paid shipping, USD", number(totals.shippingUsd)],
                ["eBay-collected tax, USD (not sales)", number(totals.ebayCollectedTaxUsd)],
                ["Order fees, USD", number(totals.orderFeesUsd)],
                ["Ad fees linked to orders, USD", number(totals.adFeesUsd)],
                ["Fees not linked to an order, USD", number(totals.monthlyFeesUsd)],
                ["Total eBay fees, USD", number(totals.totalFeesUsd)],
                ["Fees as % of sales (fees may include VAT)", `${totals.feeRatePercent}%`],
                ["Refunds, net EUR", number(totals.refundsNetEur)],
                ["Net remaining, EUR", number(totals.netRemainingEur)],
                ["Payouts in this report, EUR (timing only)", number(totals.payoutsEur)],
              ] as const).map(([label, value]) => (
                <tr key={label}><th style={cell}>{label}</th><td style={cell}>{value}</td></tr>
              ))}
            </tbody>
          </table>
          {preview.warnings.length > 0 && (
            <>
              <h3>Check these</h3>
              <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </>
          )}
          <h3>Orders ({preview.orders.length})</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse" }}>
              <thead><tr>{["Date", "Order", "Item", "SKU", "Country", "Sales USD", "Sales EUR", "Order fees USD", "Ad fees USD", "Earnings EUR", "After refund EUR", "Funds"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
              <tbody>
                {preview.orders.map((o) => (
                  <tr key={o.transactionId}>
                    <td style={cell}>{o.date}</td><td style={cell}>{o.orderNumber}</td><td style={cell}>{o.title}</td><td style={cell}>{o.customLabel ?? "—"}</td><td style={cell}>{o.shipToCountry ?? "—"}</td>
                    <td style={cell}>{number(o.salesUsd)}</td><td style={cell}>{number(o.salesEur)}</td><td style={cell}>{number(o.orderFeesUsd)}</td><td style={cell}>{number(o.adFeesUsd)}</td><td style={cell}>{number(o.earningsEur)}</td><td style={cell}>{number(o.earningsAfterRefundEur)}</td><td style={cell}>{FUNDS[o.fundsStatus] ?? o.fundsStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.refunds.length > 0 && (
            <>
              <h3>Refunds</h3>
              <ul>{preview.refunds.map((r) => <li key={`${r.orderNumber}-${r.date}`}>{r.date} · {r.orderNumber} · {r.title} · {number(r.grossUsd)} USD · net {number(r.netEur)} EUR{r.parentOrderInFile ? "" : " · order not in this report"}</li>)}</ul>
            </>
          )}
          {preview.monthlyFees.length > 0 && (
            <>
              <h3>Fees not linked to an order</h3>
              <ul>{preview.monthlyFees.map((f) => <li key={f.referenceId}>{f.date} · {f.description} · {number(f.usd)} USD · {number(f.eur)} EUR</li>)}</ul>
            </>
          )}
        </>
      )}
    </main>
  );
}
