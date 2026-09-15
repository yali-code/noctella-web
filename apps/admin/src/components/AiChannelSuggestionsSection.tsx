"use client";

import { MarketplacePreparationStatus, PublishChannel, type MarketplacePreparation, type Product } from "@noctella/shared";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { marketplacePreparationApi } from "@/lib/publishing";

interface AiChannelSuggestionsSectionProps {
  productId: string;
  channel: PublishChannel;
  /**
   * The current canonical Product version, as already known by ProductForm (see its own
   * `productUpdatedAt` state, itself initialized from EditProductPage's existing Sprint 88
   * `expectedUpdatedAt`). Used only as a client-side pre-action staleness hint - the authoritative
   * freshness check always remains the existing approve endpoint's own
   * expectedProposalUpdatedAt/baseProductUpdatedAt server-side comparison.
   */
  productUpdatedAt?: string;
  /**
   * Sprint 145: fired only after the existing marketplace-preparation approve endpoint has
   * already succeeded - never called speculatively, never called on error. `product` is the exact
   * Product the endpoint returned. ProductForm owns the narrow channel-scoped field merge and the
   * canonical version-token advancement; this component never touches ProductForm's `values` or
   * EditProductPage's `expectedUpdatedAt` directly.
   */
  onApplied: (channel: PublishChannel, product: Product) => void;
}

/**
 * Sprint 145: which of Marketplace Preparation's suggestion fields apply to a given channel, and
 * the exact key each maps to in ApproveMarketplacePreparationInput - deliberately duplicated from
 * (not imported from) products/[id]/publishing/page.tsx's own CHANNEL_FIELDS/suggestionValue,
 * since that file is explicitly required to remain byte-for-byte unchanged in this Sprint. Field
 * set and semantics are identical.
 */
const CHANNEL_FIELDS: Record<PublishChannel, Array<{ key: string; label: string; multiline?: boolean }>> = {
  [PublishChannel.Ebay]: [
    { key: "title", label: "Title" },
    { key: "description", label: "Description", multiline: true },
    { key: "conditionDescription", label: "Condition description", multiline: true },
    { key: "itemSpecifics", label: "Item specifics", multiline: true },
  ],
  [PublishChannel.Etsy]: [
    { key: "title", label: "Title" },
    { key: "description", label: "Description", multiline: true },
    { key: "tags", label: "Tags" },
    { key: "materials", label: "Materials" },
    { key: "style", label: "Style" },
    { key: "occasion", label: "Occasion" },
  ],
  [PublishChannel.NoctellaWeb]: [
    { key: "title", label: "Product name" },
    { key: "description", label: "Long description", multiline: true },
    { key: "shortDescription", label: "Short description", multiline: true },
    { key: "seoTitle", label: "SEO title" },
    { key: "metaDescription", label: "Meta description", multiline: true },
    { key: "focusKeyword", label: "Focus keyword" },
  ],
  [PublishChannel.WooCommerce]: [
    { key: "title", label: "Product name" },
    { key: "description", label: "Long description", multiline: true },
    { key: "shortDescription", label: "Short description", multiline: true },
    { key: "seoTitle", label: "SEO title" },
    { key: "metaDescription", label: "Meta description", multiline: true },
    { key: "focusKeyword", label: "Focus keyword" },
  ],
};

function suggestionText(preparation: MarketplacePreparation, key: string): string {
  if (key === "title") return preparation.suggestedTitle ?? "";
  if (key === "description") return preparation.suggestedDescription ?? "";
  if (key === "conditionDescription") return preparation.suggestedConditionDescription ?? "";
  if (key === "itemSpecifics") return preparation.suggestedItemSpecifics ?? "";
  if (key === "tags") return preparation.suggestedTags?.join(", ") ?? "";
  if (key === "materials") return preparation.suggestedMaterials ?? "";
  if (key === "style") return preparation.suggestedStyle ?? "";
  if (key === "occasion") return preparation.suggestedOccasion ?? "";
  if (key === "shortDescription") return preparation.suggestedShortDescription ?? "";
  if (key === "seoTitle") return preparation.suggestedSeoTitle ?? "";
  if (key === "metaDescription") return preparation.suggestedMetaDescription ?? "";
  if (key === "focusKeyword") return preparation.suggestedFocusKeyword ?? "";
  return "";
}

function buildEditedApprovePayload(channel: PublishChannel, edits: Record<string, string>) {
  const payload: Record<string, string | string[]> = {};
  for (const field of CHANNEL_FIELDS[channel]) {
    const value = edits[field.key]?.trim();
    if (!value) continue;
    payload[field.key] = field.key === "tags" ? value.split(",").map((tag) => tag.trim()).filter(Boolean) : value;
  }
  return payload;
}

/**
 * Sprint 145: inline AI Marketplace Preparation assistance mounted inside ProductForm's existing
 * eBay/Etsy/Noctella Web sections - reuses marketplacePreparationApi.get/generate/approve
 * unchanged (no new endpoint, no new persistence). Handles four explicit states: NONE (no
 * proposal yet - Generate), PENDING+FRESH (Accept), PENDING+STALE (Regenerate only - Accept
 * blocked client-side), APPLIED (informational only). Never publishes anything; never calls
 * executePublish/executePublishBatch.
 */
export function AiChannelSuggestionsSection({ productId, channel, productUpdatedAt, onApplied }: AiChannelSuggestionsSectionProps) {
  const [preparation, setPreparation] = useState<MarketplacePreparation | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!preparation) return;
    setEdits(Object.fromEntries(CHANNEL_FIELDS[channel].map((field) => [field.key, suggestionText(preparation, field.key)])));
  }, [preparation, channel]);

  const load = () => {
    setError(null);
    marketplacePreparationApi
      .get(productId, channel)
      .then((loaded) => setPreparation(loaded))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setPreparation(null); // NONE state - not an error.
          return;
        }
        setError(err instanceof ApiError ? err.message : "Failed to load AI suggestions");
      })
      .finally(() => setChecked(true));
  };

  useEffect(load, [productId, channel]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const loaded = await marketplacePreparationApi.generate(productId, channel);
      setPreparation(loaded);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate AI suggestions");
    } finally {
      setGenerating(false);
    }
  }

  async function handleAccept() {
    if (!preparation || preparation.status !== MarketplacePreparationStatus.Pending || isStale) return;
    setApproving(true);
    setError(null);
    try {
      const updatedProduct = await marketplacePreparationApi.approve(productId, {
        channel,
        expectedProposalUpdatedAt: preparation.updatedAt,
        ...buildEditedApprovePayload(channel, edits),
      });
      onApplied(channel, updatedProduct);
      load(); // refresh this channel's own proposal state (now "applied") - independent of ProductForm's values.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to accept AI suggestions");
    } finally {
      setApproving(false);
    }
  }

  async function handleReject() {
    if (!preparation || preparation.status !== MarketplacePreparationStatus.Pending) return;
    setRejecting(true); setError(null);
    try { setPreparation(await marketplacePreparationApi.reject(productId, channel, preparation.updatedAt)); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Failed to reject AI suggestions"); }
    finally { setRejecting(false); }
  }

  const isStale =
    !!preparation &&
    preparation.status === MarketplacePreparationStatus.Pending &&
    productUpdatedAt !== undefined &&
    preparation.baseProductUpdatedAt !== productUpdatedAt;

  if (!checked) {
    return <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>Loading AI suggestions...</p>;
  }

  return (
    <div className="noctella-panel" style={{ padding: 12, marginTop: 8 }}>
      <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 600, color: "var(--noctella-bright-star-gold)" }}>
        AI Suggestions
      </p>
      {error && <p style={{ color: "#c86a6a", fontSize: 12 }}>{error}</p>}

      {!preparation && (
        <>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            No AI suggestions generated yet for this channel.
          </p>
          <button type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating..." : "Generate AI Suggestions"}
          </button>
        </>
      )}

      {preparation && preparation.status === MarketplacePreparationStatus.Applied && (
        <>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>AI Suggestions Applied.</p>
          <button type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating..." : "Regenerate AI Suggestions"}
          </button>
        </>
      )}

      {preparation && preparation.status === MarketplacePreparationStatus.Rejected && (
        <>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>AI Suggestions Rejected.</p>
          <button type="button" onClick={handleGenerate} disabled={generating}>{generating ? "Generating..." : "Regenerate AI Suggestions"}</button>
        </>
      )}

      {preparation && preparation.status === MarketplacePreparationStatus.Pending && (
        <>
          {isStale ? (
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#c86a6a" }}>
              This suggestion is based on an earlier version of this Product. Regenerate before it can be accepted.
            </p>
          ) : (
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
              Review the AI suggestion below, then Accept to update this channel&apos;s fields.
            </p>
          )}
          <dl style={{ margin: "0 0 8px", fontSize: 12 }}>
            {CHANNEL_FIELDS[channel].map((field) => {
              const value = suggestionText(preparation, field.key);
              if (!value) return null;
              return (
                <div key={field.key} style={{ marginBottom: 6 }}>
                  <dt style={{ color: "var(--noctella-aged-bronze)" }}>{field.label}</dt>
                  <dd style={{ margin: 0, whiteSpace: field.multiline ? "pre-wrap" : "normal" }}>{value}</dd>
                </div>
              );
            })}
          </dl>
          {!isStale && CHANNEL_FIELDS[channel].map((field) => (
            <label key={`edit-${field.key}`} style={{ display: "block", marginBottom: 6, fontSize: 12 }}>
              Edit {field.label}
              {field.multiline ? <textarea aria-label={`Edit ${field.label}`} value={edits[field.key] ?? ""} onChange={(event) => setEdits((current) => ({ ...current, [field.key]: event.target.value }))} /> : <input aria-label={`Edit ${field.label}`} value={edits[field.key] ?? ""} onChange={(event) => setEdits((current) => ({ ...current, [field.key]: event.target.value }))} />}
            </label>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={handleAccept} disabled={approving || isStale}>
              {approving ? "Applying..." : "Apply Reviewed Suggestions"}
            </button>
            <button type="button" onClick={handleReject} disabled={rejecting}>{rejecting ? "Rejecting..." : "Reject Suggestions"}</button>
            <button type="button" onClick={handleGenerate} disabled={generating}>
              {generating ? "Regenerating..." : "Regenerate AI Suggestions"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
