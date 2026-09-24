"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SOCIAL_CONTENT_STATUSES, SOCIAL_CONTENT_TYPES, type SocialContent } from "@noctella/shared";
import { socialContentApi } from "@/lib/socialContent";
import { resolveApiAssetUrl } from "@/lib/api";
import { control, panel, statusLabel } from "./styles";

export default function SocialContentList() {
  const [status, setStatus] = useState("");
  const [contentType, setContentType] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SocialContent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    const query = new URLSearchParams({ page: String(page) });
    if (status) query.set("status", status);
    if (contentType) query.set("contentType", contentType);
    socialContentApi.list(query.toString()).then((result) => { if (active) { setItems(result.items); setHasMore(result.hasMore); } })
      .catch(() => { if (active) setError("Social content could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [status, contentType, page]);
  return <section><h2>Content</h2>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
      <label>Status <select style={control} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{SOCIAL_CONTENT_STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
      <label>Content type <select style={control} value={contentType} onChange={(e) => { setContentType(e.target.value); setPage(1); }}><option value="">All types</option>{SOCIAL_CONTENT_TYPES.map((value) => <option key={value}>{value}</option>)}</select></label>
      <Link href="/social/new">Create content</Link>
    </div>
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">Loading content…</p> : !items.length ? <p>No social content yet for these filters.</p> :
      <div className="noctella-panel" style={{ ...panel, overflowX: "auto" }}><table style={{ width: "100%", textAlign: "left", borderSpacing: 12 }}><thead><tr><th>Preview</th><th>Product</th><th>Platform / account</th><th>Type</th><th>Status</th><th>Updated</th><th>Open</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td>{item.media[0] ? <img src={resolveApiAssetUrl(item.media[0].thumbnailUrl)} alt={item.media[0].altText || "Content preview"} width={80} height={80} style={{ objectFit: "contain" }} /> : "No media"}</td>
          <td>{item.product ? `${item.product.sku} · ${item.product.title}` : "No product"}</td><td>Instagram / @noctella.vault</td><td>{item.contentType}</td><td>{statusLabel(item.status)}</td><td>{new Date(item.updatedAt).toLocaleString()}</td><td><Link href={`/social/${item.id}`}>View content</Link></td>
        </tr>)}</tbody></table></div>}
    <button style={control} disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>Previous</button>{" "}
    <button style={control} disabled={!hasMore || loading} onClick={() => setPage(page + 1)}>Next</button>
  </section>;
}
