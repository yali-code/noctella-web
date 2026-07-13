"use client";

import { StockMovementType } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createManualStockAdjustment,
  getProductStockHistory,
  primaryImageUrl,
  type ProductDetail,
  type StockMovement,
} from "@/lib/stock";

export default function ProductStockHistoryPage({ params }: { params: { productId: string } }) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [type, setType] = useState<StockMovementType.ManualIncrease | StockMovementType.ManualDecrease | StockMovementType.Correction>(StockMovementType.ManualIncrease);
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await getProductStockHistory(params.productId);
      setProduct(result.product);
      setMovements(result.movements);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stock history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.productId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createManualStockAdjustment({
        productId: params.productId,
        type,
        quantity: Number(quantity),
        unitCost: unitCost ? Number(unitCost) : undefined,
        note: note || undefined,
      });
      setQuantity("1");
      setUnitCost("");
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save stock adjustment");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading stock history...</p>;

  if (error && !product) {
    return (
      <div>
        <h1>Stock History</h1>
        <p style={{ color: "#c86a6a" }}>{error}</p>
        <Link href="/stock">Back to Stock</Link>
      </div>
    );
  }

  if (!product) return null;

  return (
    <div>
      <Link href="/stock" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
        ← Back to Stock
      </Link>
      <h1>Stock History</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      <section className="noctella-panel" style={{ padding: 20, display: "flex", gap: 20, alignItems: "center" }}>
        {primaryImageUrl(product) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={primaryImageUrl(product)} alt="" style={{ width: 72, height: 72, objectFit: "cover" }} />
        ) : (
          <div style={{ width: 72, height: 72, background: "var(--noctella-night-navy)" }} />
        )}
        <div>
          <h2 style={{ margin: 0 }}>{product.title}</h2>
          <p style={{ margin: "6px 0", color: "var(--noctella-aged-bronze)" }}>SKU: {product.sku}</p>
          <p style={{ margin: 0 }}>Current stock: {product.stockQuantity}</p>
          <p style={{ margin: "6px 0 0" }}>Status: {product.status}</p>
        </div>
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginTop: 20 }}>
        <h3>Manual Stock Adjustment</h3>
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label style={labelStyle}>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)} style={inputStyle}>
              <option value={StockMovementType.ManualIncrease}>ManualIncrease</option>
              <option value={StockMovementType.ManualDecrease}>ManualDecrease</option>
              <option value={StockMovementType.Correction}>Correction</option>
            </select>
          </label>
          <label style={labelStyle}>
            {type === StockMovementType.Correction ? "New stock" : "Quantity"}
            <input value={quantity} onChange={(e) => setQuantity(e.target.value)} type="number" min="1" step="1" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Unit cost
            <input value={unitCost} onChange={(e) => setUnitCost(e.target.value)} type="number" min="0" step="0.01" style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
          </label>
          <button disabled={saving} style={buttonStyle}>
            {saving ? "Saving..." : "Save Adjustment"}
          </button>
        </form>
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginTop: 20, overflowX: "auto" }}>
        <h3>Movement Timeline</h3>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Previous</th>
              <th style={thStyle}>New</th>
              <th style={thStyle}>Unit Cost</th>
              <th style={thStyle}>Currency</th>
              <th style={thStyle}>Reference Type</th>
              <th style={thStyle}>Reference ID</th>
              <th style={thStyle}>Note</th>
              <th style={thStyle}>Created</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                  No stock movements found.
                </td>
              </tr>
            )}
            {movements.map((movement) => (
              <tr key={movement.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>{movement.type}</td>
                <td style={tdStyle}>{movement.quantity}</td>
                <td style={tdStyle}>{movement.previousStock}</td>
                <td style={tdStyle}>{movement.newStock}</td>
                <td style={tdStyle}>{movement.unitCost ?? "—"}</td>
                <td style={tdStyle}>{movement.currency ?? "—"}</td>
                <td style={tdStyle}>{movement.referenceType ?? "—"}</td>
                <td style={tdStyle}>{movement.referenceId ?? "—"}</td>
                <td style={tdStyle}>{movement.note ?? "—"}</td>
                <td style={tdStyle}>{new Date(movement.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "var(--noctella-aged-bronze)",
};

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
