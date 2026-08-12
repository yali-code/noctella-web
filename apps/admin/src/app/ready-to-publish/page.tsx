"use client";

import { PublishChannel, type Category } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, resolveApiAssetUrl } from "@/lib/api";
import { marketplaceApi } from "@/lib/marketplaces";
import type { PaginatedResult, ProductListItem } from "@/lib/types";

const PAGE_SIZE = 20;

/**
 * Sprint 136: the dedicated Ready to Publish operational queue. Membership authority is
 * Product.status === ProductStatus.Approved alone (no additional predicate - see the Sprint 136
 * discovery report) - the status filter below is hard-coded by this screen's own logic, never a
 * user-selectable option, so this page can never show Draft/PendingReview/Published/Sold/
 * Archived/Returned/AiPrepared products. Reuses the existing canonical product list endpoint
 * (GET /api/products?status=approved) exactly as apps/admin/src/app/products/page.tsx already
 * does for its own status filter - no new backend endpoint. Preview/Edit/Publish reuse the
 * existing publishing preview page, the existing product editor, and the existing authoritative
 * executePublish action respectively; none of those are duplicated here.
 */
export default function ReadyToPublishPage() {
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sprint 136 correction (Exact Review Required Fix #1): per-row in-flight publish state must be
  // a set, not a single scalar - a single productId | null cannot represent two different rows
  // publishing concurrently. Publishing a second row would previously overwrite the first row's
  // in-flight id, silently re-enabling its button and defeating its own guard, allowing a genuine
  // duplicate executePublish call for the still-pending first row. A Set correctly tracks every
  // row independently: adding/removing one row's id never affects any other row's membership.
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set());
  const [publishErrors, setPublishErrors] = useState<Record<string, string>>({});

  // Sprint 136 correction (Exact Review Required Fix #2): mirrors the latest committed `items`
  // array for use inside handlePublish's async continuation, so the last-row-on-page decision
  // below is made from current state rather than the stale closure `items` value captured back
  // when handlePublish was invoked (which could already be out of date by the time the publish
  // promise resolves, e.g. because a concurrent publish for a different row already completed).
  const itemsRef = useRef<ProductListItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
  }, []);

  // Sprint 136: mirrors products/page.tsx's own established convention - the fetch is inlined
  // directly in the effect body (not extracted to a named function passed as the effect callback),
  // both to match the existing pattern and because a useEffect callback must return undefined or a
  // cleanup function, never the fetch's own Promise chain.
  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      status: "approved",
    });
    if (search) params.set("search", search);
    if (categoryId) params.set("categoryId", categoryId);

    api
      .get<PaginatedResult<ProductListItem>>(`/api/products?${params.toString()}`)
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => setError(err.message ?? "Failed to load Ready to Publish products"))
      .finally(() => setLoading(false));
  }, [page, search, categoryId]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const categoryName = (id?: string) => categories.find((c) => c.id === id)?.name ?? "—";

  async function handlePublish(productId: string) {
    if (publishingIds.has(productId)) return;
    setPublishingIds((prev) => new Set(prev).add(productId));
    setPublishErrors((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
    try {
      await marketplaceApi.executePublish(productId, PublishChannel.NoctellaWeb);
      // Sprint 136: the Product is already Published through the existing authoritative publish
      // flow at this point - this only updates the locally visible queue, it never writes
      // Product.status itself. Removing the row locally (rather than a full re-fetch) is the
      // smallest robust option consistent with existing Admin list pages.
      //
      // Sprint 136 correction (Required Fix #2): functional updates only - never derive the next
      // array/total from the closure-captured `items`/`total`, which can be stale by the time this
      // continuation runs (e.g. a concurrent publish for a different row already committed its own
      // removal, or a search/category/page change already replaced `items` with a fresh fetch
      // result). Reading `current` inside the updater guarantees this always applies against
      // whatever is actually the latest state at commit time, so it can never resurrect an
      // already-removed row or overwrite a fresher fetch.
      setItems((current) => current.filter((item) => item.id !== productId));
      setTotal((current) => Math.max(0, current - 1));
      // Sprint 136: publishing the last row on a page beyond page 1 would otherwise strand the
      // operator on an empty page - step back one page so the existing pagination effect re-fetches
      // a page that actually has content. itemsRef mirrors the latest committed `items` (see
      // above), so this prediction of the post-removal count is based on current state, not the
      // stale `items` closure.
      const remainingOnPage = itemsRef.current.filter((item) => item.id !== productId).length;
      if (remainingOnPage === 0 && page > 1) {
        setPage((current) => current - 1);
      }
      setPublishingIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
    } catch (err) {
      setPublishingIds((prev) => {
        const next = new Set(prev);
        next.delete(productId);
        return next;
      });
      setPublishErrors((prev) => ({
        ...prev,
        [productId]: err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed to publish product",
      }));
    }
  }

  return (
    <div>
      <h1>Ready to Publish</h1>
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
              <th style={thStyle}>Product</th>
              <th style={thStyle}>Category</th>
              <th style={thStyle}>SKU</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                  No products are ready to publish.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {item.primaryImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={resolveApiAssetUrl(item.primaryImageUrl)}
                        alt=""
                        style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 4,
                          background: "var(--noctella-night-navy)",
                          border: "1px solid var(--noctella-aged-bronze)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span>{item.title}</span>
                  </div>
                </td>
                <td style={tdStyle}>{categoryName(item.categoryId)}</td>
                <td style={tdStyle}>{item.sku}</td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <Link href={`/products/${item.id}/publishing`} style={{ color: "var(--noctella-bright-star-gold)" }}>
                      Preview
                    </Link>
                    <Link href={`/products/${item.id}/edit`} style={{ color: "var(--noctella-bright-star-gold)" }}>
                      Edit
                    </Link>
                    <button
                      onClick={() => handlePublish(item.id)}
                      disabled={publishingIds.has(item.id)}
                      style={buttonStyle}
                    >
                      {publishingIds.has(item.id) ? "Publishing..." : "Publish"}
                    </button>
                  </div>
                  {publishErrors[item.id] && (
                    <p role="alert" style={{ color: "#c86a6a", fontSize: 12, margin: "6px 0 0" }}>
                      {publishErrors[item.id]}
                    </p>
                  )}
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
