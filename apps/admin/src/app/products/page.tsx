"use client";

import {
  PRODUCT_STATUS_VALUES,
  PRODUCT_TYPE_VALUES,
  type Category,
  type Collection,
} from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PaginatedResult, ProductListItem } from "@/lib/types";

const PAGE_SIZE = 20;

export default function ProductsPage() {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
    api
      .get<PaginatedResult<Collection>>("/api/collections?pageSize=100")
      .then((res) => setCollections(res.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    if (categoryId) params.set("categoryId", categoryId);
    if (collectionId) params.set("collectionId", collectionId);

    api
      .get<PaginatedResult<ProductListItem>>(`/api/products?${params.toString()}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message ?? "Failed to load products"))
      .finally(() => setLoading(false));
  }, [page, search, status, type, categoryId, collectionId]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const categoryName = (id?: string) => categories.find((c) => c.id === id)?.name ?? "—";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Products</h1>
        <Link
          href="/products/new"
          className="noctella-panel"
          style={{
            padding: "10px 18px",
            fontSize: 14,
            color: "var(--noctella-bright-star-gold)",
            border: "1px solid var(--noctella-antique-gold)",
          }}
        >
          + New Product
        </Link>
      </div>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <input
          placeholder="Search title or SKU"
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
          <option value="">All statuses</option>
          {PRODUCT_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => {
            setPage(1);
            setType(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">All types</option>
          {PRODUCT_TYPE_VALUES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={categoryId}
          onChange={(e) => {
            setPage(1);
            setCategoryId(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={collectionId}
          onChange={(e) => {
            setPage(1);
            setCollectionId(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">All collections</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p style={{ color: "#c86a6a", marginBottom: 16 }}>
          {error} — is the API running at the configured NEXT_PUBLIC_API_BASE_URL?
        </p>
      )}

      <div className="noctella-panel" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={thStyle}></th>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>SKU</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Category</th>
              <th style={thStyle}>EUR Price</th>
              <th style={thStyle}>Stock</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                  No products found.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>
                  {item.primaryImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.primaryImageUrl}
                      alt=""
                      style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4 }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 4,
                        background: "var(--noctella-night-navy)",
                        border: "1px solid var(--noctella-aged-bronze)",
                      }}
                    />
                  )}
                </td>
                <td style={tdStyle}>
                  <Link href={`/products/${item.id}`} style={{ color: "var(--noctella-ivory)" }}>
                    {item.title}
                  </Link>
                </td>
                <td style={tdStyle}>{item.sku}</td>
                <td style={tdStyle}>{item.type}</td>
                <td style={tdStyle}>{categoryName(item.categoryId)}</td>
                <td style={tdStyle}>€{item.priceEur.toFixed(2)}</td>
                <td style={tdStyle}>{item.stockQuantity}</td>
                <td style={tdStyle}>{item.status}</td>
                <td style={tdStyle}>{new Date(item.updatedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
        <span style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          Page {page} of {totalPages} ({total} total)
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={buttonStyle}
          >
            Previous
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            style={buttonStyle}
          >
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
