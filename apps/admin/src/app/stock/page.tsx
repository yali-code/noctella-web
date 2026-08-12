"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { listStockProducts } from "@/lib/stock";
import type { Category, PaginatedResult, ProductListItem } from "@/lib/types";

export default function StockPage() {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listStockProducts().then((res) => setItems(res.items)).catch((err) => setError(err.message));
    // Sprint 137: same client-side category-name resolution pattern already used by
    // products/page.tsx and ready-to-publish/page.tsx - reuses the existing categories endpoint,
    // no new backend capability needed.
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
  }, []);

  const categoryName = (id?: string) => categories.find((c) => c.id === id)?.name ?? "—";

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
              <th style={cell}>Product</th><th style={cell}>Quantity</th><th style={cell}>Category</th><th style={cell}>SKU</th><th style={cell}>Status</th><th style={cell}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={cell}>{item.title}</td>
                <td style={cell}>{item.stockQuantity}</td>
                <td style={cell}>{categoryName(item.categoryId)}</td>
                <td style={cell}>{item.sku}</td>
                <td style={cell}>{item.status}</td>
                <td style={cell}>
                  <Link href={`/products/${item.id}/label`} style={{ marginRight: 12 }}>Print Barcode</Link>
                  <Link href={`/stock/${item.id}`}>View timeline</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: "10px 12px" };
