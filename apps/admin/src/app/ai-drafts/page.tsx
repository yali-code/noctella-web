"use client";

import { AI_DRAFT_STATUS_VALUES, type Category } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AiDraftListItem, PaginatedResult } from "@/lib/types";

const PAGE_SIZE = 20;

export default function AiDraftsPage() {
  const [items, setItems] = useState<AiDraftListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("search", search);
    if (status) params.set("status", status);

    api
      .get<PaginatedResult<AiDraftListItem>>(`/api/ai-drafts?${params.toString()}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message ?? "Failed to load AI drafts"))
      .finally(() => setLoading(false));
  }, [page, search, status]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const categoryName = (id?: string) => categories.find((c) => c.id === id)?.name ?? "—";

  return (
    <div>
      <h1>AI Drafts</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
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
          {AI_DRAFT_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
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
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Suggested Category</th>
              <th style={thStyle}>Suggested EUR Price</th>
              <th style={thStyle}>Confidence</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                  No AI drafts found.
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
                  <Link href={`/ai-drafts/${item.id}`} style={{ color: "var(--noctella-ivory)" }}>
                    {item.productTitle}
                  </Link>
                </td>
                <td style={tdStyle}>{item.productSku}</td>
                <td style={tdStyle}>{item.status}</td>
                <td style={tdStyle}>{categoryName(item.suggestedCategoryId)}</td>
                <td style={tdStyle}>
                  {item.suggestedEurPrice !== undefined ? `€${item.suggestedEurPrice.toFixed(2)}` : "—"}
                </td>
                <td style={tdStyle}>
                  {item.aiConfidenceScore !== undefined ? `${Math.round(item.aiConfidenceScore * 100)}%` : "—"}
                </td>
                <td style={tdStyle}>{new Date(item.createdAt).toLocaleDateString()}</td>
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
          <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={buttonStyle}>
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
