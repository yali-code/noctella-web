"use client";

import { type Category } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PaginatedResult, PendingPublishItem } from "@/lib/types";

const PAGE_SIZE = 20;

/**
 * Sprint 139: formats an ISO timestamp as DD.MM.YYYY by slicing the stored UTC date string
 * directly, never by constructing a Date and reading local-timezone-dependent fields (e.g.
 * toLocaleDateString()) - the approved requirement is that the displayed calendar date must never
 * shift away from the authoritative stockAcceptedAt value because of the viewer's timezone.
 */
function formatStockAccepted(iso: string): string {
  const [datePart] = iso.split("T");
  const [year, month, day] = datePart.split("-");
  return `${day}.${month}.${year}`;
}

/**
 * Sprint 139: Pending Publish - the Admin operational queue for Products that have genuinely
 * completed Warehouse Stock Acceptance and have not yet reached a terminal published/archived
 * state. Was Sprint 136's Ready to Publish queue (Product.status === "approved" only, hard-coded
 * Preview/Edit/Publish actions); the route (/ready-to-publish) is unchanged, but membership,
 * columns, and the row action are replaced to match the approved Sprint 139 contract: membership
 * now comes from GET /api/products/pending-publish (Stock Acceptance provenance, not a status
 * filter - see repositories/product-read/drizzle.ts's listPendingPublish), and the single "Edit /
 * Publish" action is pure navigation to the existing publishing page - this page itself never
 * mutates a Product or triggers a publish.
 *
 * Required Fix #1: the Category filter dropdown (a filter control, not a table column) was
 * unintentionally dropped from the original Sprint 139 pass - restored here with the exact same
 * mechanics as the Sprint 136 baseline (load categories once, categoryId "" = all, reset page to 1
 * on change), now sent to the dedicated Pending Publish endpoint instead of the old generic
 * status=approved one. The backend's listPendingPublish/countPendingPublish already AND categoryId
 * together with Stock Acceptance provenance (see drizzle.ts's pendingPublishWhere) - no backend
 * change was needed for this fix, only wiring the existing capability up from this page.
 */
export default function ReadyToPublishPage() {
  const [items, setItems] = useState<PendingPublishItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
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
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (search) params.set("search", search);
    if (categoryId) params.set("categoryId", categoryId);

    api
      .get<PaginatedResult<PendingPublishItem>>(`/api/products/pending-publish?${params.toString()}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message ?? "Failed to load Pending Publish products"))
      .finally(() => setLoading(false));
  }, [page, search, categoryId]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1>Pending Publish</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <input
          placeholder="Search title"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          style={inputStyle}
        />
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
              <th style={thStyle}>Product Name</th>
              <th style={thStyle}>Stock Accepted</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={3} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                  No products are waiting to be published.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>{item.title}</td>
                <td style={tdStyle}>{formatStockAccepted(item.stockAcceptedAt)}</td>
                <td style={tdStyle}>
                  <Link href={`/products/${item.id}/publishing`} style={{ color: "var(--noctella-bright-star-gold)" }}>
                    Edit / Publish
                  </Link>
                </td>
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
          <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} style={buttonStyle}>
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
