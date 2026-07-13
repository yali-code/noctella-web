"use client";

import { useParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { createStockAdjustment, listStockMovements } from "@/lib/stock";
import type { StockMovement } from "@noctella/shared";

export default function ProductStockPage() {
  const { productId } = useParams<{ productId: string }>();
  const [items, setItems] = useState<StockMovement[]>([]);
  const [quantityDelta, setQuantityDelta] = useState("0");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => listStockMovements(productId).then((res) => setItems(res.items)).catch((err) => setError(err.message)), [productId]);
  useEffect(() => { load(); }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createStockAdjustment({ productId, quantityDelta: Number(quantityDelta), note: note || undefined });
      setQuantityDelta("0"); setNote(""); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to adjust stock"); }
  }

  return (
    <div>
      <h1>Stock timeline</h1>
      <p style={{ color: "var(--noctella-aged-bronze)" }}>Product ID: {productId}</p>
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      <form onSubmit={submit} className="noctella-panel" style={{ display: "flex", gap: 12, margin: "16px 0" }}>
        <input aria-label="Quantity delta" type="number" value={quantityDelta} onChange={(e) => setQuantityDelta(e.target.value)} style={input} />
        <input aria-label="Adjustment note" placeholder="Adjustment note" value={note} onChange={(e) => setNote(e.target.value)} style={input} />
        <button style={input}>Apply adjustment</button>
      </form>
      <div className="noctella-panel" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left" }}><th style={cell}>When</th><th style={cell}>Type</th><th style={cell}>Delta</th><th style={cell}>Before</th><th style={cell}>After</th><th style={cell}>Note</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id}><td style={cell}>{new Date(item.createdAt).toLocaleString()}</td><td style={cell}>{item.type}</td><td style={cell}>{item.quantityDelta}</td><td style={cell}>{item.stockBefore}</td><td style={cell}>{item.stockAfter}</td><td style={cell}>{item.note ?? "—"}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

const input: React.CSSProperties = { background: "var(--noctella-deep-star-blue)", border: "1px solid var(--noctella-antique-gold)", color: "var(--noctella-ivory)", borderRadius: 4, padding: "8px 10px" };
const cell: React.CSSProperties = { padding: "10px 12px" };
