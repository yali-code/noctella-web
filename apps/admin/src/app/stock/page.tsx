"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  listStockListItems,
  paginateStockItems,
  primaryImageUrl,
  type StockListItem,
  type StockStateFilter,
} from "@/lib/stock";

const PAGE_SIZE = 20;

export default function StockPage() {
  const [allItems, setAllItems] = useState<StockListItem[]>([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [state, setState] = useState<StockStateFilter>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listStockListItems(search, state)
      .then((items) => setAllItems(items))
      .catch((err) => setError(err.message ?? "Failed to load stock"))
      .finally(() => setLoading(false));
  }, [search, state]);

  const paged = paginateStockItems(allItems, page, PAGE_SIZE);

  return (
    <div>
      <h1>Stock</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <input
          placeholder="Search product title or SKU"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          style={inputStyle}
        />
        <select
          value={state}
          onChange={(e) => {
            setPage(1);
            setState(e.target.value as StockStateFilter);
          }}
          style={inputStyle}
        >
          <option value="">All stock states</option>
          <option value="in_stock">In Stock</option>
          <option value="out_of_stock">Out of Stock</option>
        </select>
      </div>

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading stock...</p>}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      {!loading && !error && (
        <div className="noctella-panel" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
                <th style={thStyle}>Image</th>
                <th style={thStyle}>Product</th>
                <th style={thStyle}>SKU</th>
                <th style={thStyle}>Current Stock</th>
                <th style={thStyle}>Latest Type</th>
                <th style={thStyle}>Latest Qty</th>
                <th style={thStyle}>Latest Date</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                    No stock records found.
                  </td>
                </tr>
              )}
              {paged.items.map(({ product, latestMovement }) => (
                <tr key={product.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                  <td style={tdStyle}>
                    {primaryImageUrl(product) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={primaryImageUrl(product)} alt="" style={{ width: 40, height: 40, objectFit: "cover" }} />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={tdStyle}>
                    <Link href={`/stock/${product.id}`} style={{ color: "var(--noctella-ivory)" }}>
                      {product.title}
                    </Link>
                  </td>
                  <td style={tdStyle}>{product.sku}</td>
                  <td style={tdStyle}>{product.stockQuantity}</td>
                  <td style={tdStyle}>{latestMovement?.type ?? "—"}</td>
                  <td style={tdStyle}>{latestMovement?.quantity ?? "—"}</td>
                  <td style={tdStyle}>{latestMovement ? new Date(latestMovement.createdAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
        <span style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Page {page} of {paged.totalPages} ({allItems.length} total)
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={buttonStyle}>
            Previous
          </button>
          <button disabled={page >= paged.totalPages} onClick={() => setPage((p) => Math.min(paged.totalPages, p + 1))} style={buttonStyle}>
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
