"use client";

import type { MarketingTag } from "@noctella/shared";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { marketingTagsApi } from "@/lib/marketingTags";

interface MarketingTagsSectionProps {
  productId: string;
}

/**
 * Sprint 144: Product Marketing Tags inside the canonical Product Edit form (ProductForm). Reuses
 * the existing Sprint 140 marketingTagsApi (list/add/remove) unchanged - no new endpoint, no
 * storage/domain change, and this remains a distinct concept from the per-channel Etsy tags edited
 * elsewhere in ProductForm.
 *
 * Deliberately self-contained: its own load/add/remove state is entirely separate from
 * ProductForm's `values`/onSubmit state, so a tag add/remove can never reset unsaved Product field
 * edits, and editing an unrelated Product field can never trigger a tag mutation. Every button here
 * is explicitly `type="button"` - this component renders inside ProductForm's own <form>, where a
 * default (type="submit") button would incorrectly trigger a full Product save/publish attempt.
 *
 * Rendered only when a productId is known (see ProductForm) - create mode never mounts this
 * component and therefore never calls the Marketing Tags API for a Product that does not exist yet.
 */
export function MarketingTagsSection({ productId }: MarketingTagsSectionProps) {
  const [tags, setTags] = useState<MarketingTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const load = () => {
    setError(null);
    marketingTagsApi
      .list(productId)
      .then(setTags)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load Marketing Tags"));
  };

  useEffect(load, [productId]);

  async function handleAdd() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    setError(null);
    try {
      await marketingTagsApi.add(productId, label);
      setNewLabel("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add Marketing Tag");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(tagId: string) {
    setError(null);
    try {
      await marketingTagsApi.remove(productId, tagId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove Marketing Tag");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {error && <p style={{ color: "#c86a6a", margin: 0, fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {tags.length === 0 && (
          <p style={{ margin: 0, color: "var(--noctella-aged-bronze)", fontSize: 13 }}>No Marketing Tags yet.</p>
        )}
        {tags.map((tag) => (
          <span
            key={tag.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              border: "1px solid var(--noctella-antique-gold)",
              borderRadius: 999,
              fontSize: 13,
            }}
          >
            {tag.label}
            <button
              type="button"
              onClick={() => handleRemove(tag.id)}
              aria-label={`Remove ${tag.label}`}
              style={{ border: "none", background: "none", cursor: "pointer" }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <input
          placeholder="e.g. Father's Day"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          style={{
            background: "var(--noctella-night-navy)",
            border: "1px solid var(--noctella-aged-bronze)",
            color: "var(--noctella-ivory)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: 13,
          }}
        />
        <button type="button" onClick={handleAdd} disabled={adding || !newLabel.trim()}>
          {adding ? "Adding..." : "Add Tag"}
        </button>
      </div>
    </div>
  );
}
