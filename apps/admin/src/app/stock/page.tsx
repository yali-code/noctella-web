"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listStockProducts } from "@/lib/stock";
import type { ProductListItem } from "@/lib/types";

export default function StockPage() {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listStockProducts().then((res) => setItems(res.items)).catch((err) => setError(err.message));
  }, []);

  return (
    <div>
      <h1>Stock</h1>
      <p style={{ color: "var(--noctella-aged-bronze)" }}>Current inventory quantities and movement history.</p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      <div className="noctella-panel" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={cell}>Product</th><th style={cell}>SKU</th><th style={cell}>Status</th><th style={cell}>Stock</th><th style={cell}>History</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={cell}>{item.title}</td><td style={cell}>{item.sku}</td><td style={cell}>{item.status}</td><td style={cell}>{item.stockQuantity}</td>
                <td style={cell}><Link href={`/stock/${item.id}`}>View timeline</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: "10px 12px" };
