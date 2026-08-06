"use client";

import { AI_PRODUCT_INTAKE_STATUS_VALUES, type AiProductIntake } from "@noctella/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";
import type { PaginatedResult } from "@/lib/types";

const PAGE_SIZE = 20;

export default function AiProductIntakesPage() {
  const router = useRouter();
  const [items, setItems] = useState<AiProductIntake[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    aiProductIntakesApi
      .list({ page, pageSize: PAGE_SIZE, status: status || undefined })
      .then((res: PaginatedResult<AiProductIntake>) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load AI product intakes"))
      .finally(() => setLoading(false));
  }, [page, status]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const created = await aiProductIntakesApi.create();
      router.push(`/ai-product-intakes/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create AI product intake");
      setCreating(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>AI Product Intake</h1>
        <button onClick={handleCreate} disabled={creating} style={primaryButtonStyle}>
          {creating ? "Creating..." : "New Intake"}
        </button>
      </div>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">All statuses</option>
          {AI_PRODUCT_INTAKE_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && <p style={{ color: "#c86a6a", marginBottom: 16 }}>{error}</p>}

      <div className="noctella-panel" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}>Result Product</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 24, textAlign: "center", color: "var(--noctella-aged-bronze)" }}>
                  No AI product intakes found.
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                <td style={tdStyle}>
                  <Link href={`/ai-product-intakes/${item.id}`} style={{ color: "var(--noctella-ivory)" }}>
                    {item.status}
                  </Link>
                </td>
                <td style={tdStyle}>{new Date(item.createdAt).toLocaleString()}</td>
                <td style={tdStyle}>{new Date(item.updatedAt).toLocaleString()}</td>
                <td style={tdStyle}>{item.resultProductId ?? "—"}</td>
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

const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
