"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { filterStockRows, loadStockDashboard, stockDate, stockPeriodBounds, stockSummary, type StockPeriod, type StockRow } from "@/lib/stockDashboard";
import { formatEur } from "@/lib/productCardDomain";
import type { Category } from "@/lib/types";

export default function StockPage() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<StockPeriod>("this-month");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  useEffect(() => {
    let active = true;
    loadStockDashboard().then((data) => {
      if (active) { setRows(data.rows); setCategories(data.categories); }
    }).catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const categoryName = (id?: string) => categories.find((c) => c.id === id)?.name ?? "—";
  const now = new Date();
  const summary = stockSummary(rows, now);
  const visible = filterStockRows(rows, period, now, start, end);
  const invalidRange = period === "custom" && !stockPeriodBounds(period, now, start, end);

  if (loading) return <div><h1>Stock</h1><p role="status">Loading stock…</p></div>;
  if (error) return <div><h1>Stock</h1><p role="alert">{error}</p></div>;

  return (
    <div>
      <h1>Stock</h1>
      <p style={{ color: "var(--noctella-aged-bronze)" }}>Current inventory quantities and movement history.</p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <p>Overview of all stock. The date filters below apply to stock-entry rows.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 20 }}>
        {[
          ["Stock Products", String(summary.products)],
          ["Units in Stock", String(summary.units)],
          ["Received This Month", String(summary.receivedThisMonth)],
          ["Recorded Stock Cost", summary.recordedCost === null ? "Not recorded" : formatEur(summary.recordedCost)],
        ].map(([label, value]) => <section className="noctella-panel" key={label} style={{ padding: 16 }} aria-label={label}><h2 style={{ fontSize: 16 }}>{label}</h2><p style={{ fontSize: 24, margin: "8px 0" }}>{value}</p></section>)}
      </div>
      <p style={{ color: "var(--noctella-aged-bronze)" }}>Recorded Stock Cost = recorded Product unit purchase cost × current quantity (EUR). {summary.excludedCosts} in-stock products with unknown or unusable costs excluded.</p>
      <div role="group" aria-label="Stock entry period" style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "20px 0" }}>
        {([["this-month", "This Month"], ["last-month", "Last Month"], ["all", "All"], ["custom", "Custom Range"]] as const).map(([value, label]) =>
          <button key={value} style={{ ...filterButton, fontWeight: period === value ? 700 : 400, background: period === value ? "var(--noctella-antique-gold)" : filterButton.background, color: period === value ? "var(--noctella-night-navy)" : filterButton.color }} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}
      </div>
      {period === "custom" && <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
        <label>From <input style={filterButton} type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Through <input style={filterButton} type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>}
      <p>Stocked On uses the opening stock movement in your local timezone. All includes products without a recorded opening movement.</p>
      {invalidRange ? <p role="status">Choose a valid start and end date (both included).</p> : <p>{visible.length} products shown</p>}
      <div className="noctella-panel" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={cell}>Product</th><th style={cell}>Quantity</th><th style={cell}>Category</th><th style={cell}>SKU</th><th style={cell}>Stocked On</th><th style={cell}>Status</th><th style={cell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ product: item, opening }) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={cell}>{item.title}</td>
                <td style={cell}>{item.stockQuantity}</td>
                <td style={cell}>{categoryName(item.categoryId)}</td>
                <td style={cell}>{item.sku}</td>
                <td style={cell}>{stockDate(opening?.createdAt)}</td>
                <td style={cell}>{item.status}</td>
                <td style={cell}>
                  <Link href={`/stock/${item.id}/card`} style={{ marginRight: 12 }}>Card</Link>
                  <Link href={`/products/${item.id}/label`} style={{ marginRight: 12 }}>Print Barcode</Link>
                  <Link href={`/stock/${item.id}`}>Timeline</Link>
                </td>
              </tr>
            ))}
            {!visible.length && !invalidRange && <tr><td style={cell} colSpan={7}>No stock entries in this period.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: "10px 12px" };
const filterButton: React.CSSProperties = { background: "var(--noctella-deep-star-blue)", color: "var(--noctella-ivory)", border: "1px solid var(--noctella-antique-gold)", borderRadius: 4, padding: "8px 12px" };
