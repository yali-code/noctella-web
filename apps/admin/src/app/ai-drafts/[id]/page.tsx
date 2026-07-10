"use client";

import type { Category, Collection } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AiListingDraft, PaginatedResult, ProductDetail } from "@/lib/types";

interface EditableFields {
  generatedTitle: string;
  generatedDescription: string;
  generatedStory: string;
  generatedConditionDescription: string;
  suggestedCategoryId: string;
  suggestedCollectionId: string;
  suggestedEurPrice: string;
  suggestedUsdPrice: string;
  suggestedMinimumOfferPrice: string;
  seoTitle: string;
  metaDescription: string;
  keywords: string;
  shippingNote: string;
  customsWarning: boolean;
}

function draftToFields(draft: AiListingDraft): EditableFields {
  return {
    generatedTitle: draft.generatedTitle ?? "",
    generatedDescription: draft.generatedDescription ?? "",
    generatedStory: draft.generatedStory ?? "",
    generatedConditionDescription: draft.generatedConditionDescription ?? "",
    suggestedCategoryId: draft.suggestedCategoryId ?? "",
    suggestedCollectionId: draft.suggestedCollectionId ?? "",
    suggestedEurPrice: draft.suggestedEurPrice?.toString() ?? "",
    suggestedUsdPrice: draft.suggestedUsdPrice?.toString() ?? "",
    suggestedMinimumOfferPrice: draft.suggestedMinimumOfferPrice?.toString() ?? "",
    seoTitle: draft.seoTitle ?? "",
    metaDescription: draft.metaDescription ?? "",
    keywords: draft.keywords?.join(", ") ?? "",
    shippingNote: draft.shippingNote ?? "",
    customsWarning: draft.customsWarning ?? false,
  };
}

export default function AiDraftReviewPage({ params }: { params: { id: string } }) {
  const [draft, setDraft] = useState<AiListingDraft | null>(null);
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [fields, setFields] = useState<EditableFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    const loadedDraft = await api.get<AiListingDraft>(`/api/ai-drafts/${params.id}`);
    setDraft(loadedDraft);
    setFields(draftToFields(loadedDraft));
    const loadedProduct = await api.get<ProductDetail>(`/api/products/${loadedDraft.productId}`);
    setProduct(loadedProduct);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message ?? "Failed to load draft"));
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
    api
      .get<PaginatedResult<Collection>>("/api/collections?pageSize=100")
      .then((res) => setCollections(res.items))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  function set<K extends keyof EditableFields>(key: K, value: EditableFields[K]) {
    setFields((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function toPatchPayload() {
    if (!fields) return {};
    const num = (v: string) => (v !== "" ? Number(v) : undefined);
    return {
      generatedTitle: fields.generatedTitle || undefined,
      generatedDescription: fields.generatedDescription || undefined,
      generatedStory: fields.generatedStory || undefined,
      generatedConditionDescription: fields.generatedConditionDescription || undefined,
      suggestedCategoryId: fields.suggestedCategoryId || undefined,
      suggestedCollectionId: fields.suggestedCollectionId || undefined,
      suggestedEurPrice: num(fields.suggestedEurPrice),
      suggestedUsdPrice: num(fields.suggestedUsdPrice),
      suggestedMinimumOfferPrice: num(fields.suggestedMinimumOfferPrice),
      seoTitle: fields.seoTitle || undefined,
      metaDescription: fields.metaDescription || undefined,
      keywords: fields.keywords
        ? fields.keywords.split(",").map((k) => k.trim()).filter(Boolean)
        : undefined,
      shippingNote: fields.shippingNote || undefined,
      customsWarning: fields.customsWarning,
    };
  }

  async function handleSave() {
    if (!draft) return;
    setBusy("save");
    setError(null);
    try {
      const updated = await api.patch<AiListingDraft>(`/api/ai-drafts/${draft.id}`, toPatchPayload());
      setDraft(updated);
      setFields(draftToFields(updated));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save draft");
    } finally {
      setBusy(null);
    }
  }

  async function handleApprove() {
    if (!draft) return;
    setBusy("approve");
    setError(null);
    try {
      // Save any pending edits first so approval uses the latest reviewed values.
      const saved = await api.patch<AiListingDraft>(`/api/ai-drafts/${draft.id}`, toPatchPayload());
      const approved = await api.post<AiListingDraft>(`/api/ai-drafts/${saved.id}/approve`, {});
      setDraft(approved);
      const refreshedProduct = await api.get<ProductDetail>(`/api/products/${approved.productId}`);
      setProduct(refreshedProduct);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to approve draft");
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    if (!draft) return;
    setBusy("reject");
    setError(null);
    try {
      const rejected = await api.post<AiListingDraft>(`/api/ai-drafts/${draft.id}/reject`, {
        rejectionReason,
      });
      setDraft(rejected);
      setShowRejectForm(false);
      setRejectionReason("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reject draft");
    } finally {
      setBusy(null);
    }
  }

  async function handleRegenerate() {
    if (!draft) return;
    setBusy("regenerate");
    setError(null);
    try {
      const regenerated = await api.post<AiListingDraft>(`/api/ai-drafts/${draft.id}/regenerate`, {});
      // Regeneration creates a new draft id — navigate the view to it.
      window.location.href = `/ai-drafts/${regenerated.id}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to regenerate draft");
      setBusy(null);
    }
  }

  if (error && !draft) return <p style={{ color: "#c86a6a" }}>{error}</p>;
  if (!draft || !product || !fields) {
    return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading...</p>;
  }

  const isEditable = draft.status === "pending_review";
  const primaryImage = product.images.find((img) => img.isPrimary) ?? product.images[0];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Review AI Draft</h1>
        <Link href="/ai-drafts" style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
          ← Back to AI Drafts
        </Link>
      </div>
      <p style={{ color: "var(--noctella-aged-bronze)", fontSize: 13, marginTop: 4 }}>
        Status: <strong style={{ color: "var(--noctella-bright-star-gold)" }}>{draft.status}</strong>
        {draft.aiConfidenceScore !== undefined && (
          <> · Confidence: {Math.round(draft.aiConfidenceScore * 100)}%</>
        )}
      </p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {error && <p style={{ color: "#c86a6a", marginBottom: 16 }}>{error}</p>}

      {draft.status === "rejected" && draft.rejectionReason && (
        <p style={{ color: "#c86a6a", marginBottom: 16 }}>Rejected: {draft.rejectionReason}</p>
      )}

      <div style={{ display: "flex", gap: 32, alignItems: "flex-start" }}>
        <div className="noctella-panel" style={{ flex: 1, padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>Existing Product Information</h3>
          {primaryImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={primaryImage.url}
              alt={primaryImage.altText ?? ""}
              style={{
                width: "100%",
                maxWidth: 240,
                height: 180,
                objectFit: "cover",
                borderRadius: 4,
                border: "1px solid var(--noctella-antique-gold)",
                marginBottom: 16,
              }}
            />
          )}
          <Row label="SKU" value={product.sku} />
          <Row label="Title" value={product.title} />
          <Row label="Category" value={categories.find((c) => c.id === product.categoryId)?.name ?? "—"} />
          <Row label="EUR Price" value={`€${product.priceEur.toFixed(2)}`} />
          {product.priceUsd !== undefined && <Row label="USD Price" value={`$${product.priceUsd.toFixed(2)}`} />}
          <Row label="Condition" value={product.condition ?? "—"} />
          <Row label="Condition Description" value={product.conditionDescription ?? "—"} />
          <Row label="Purchase Cost" value={product.purchaseCost !== undefined ? String(product.purchaseCost) : "—"} />
          <Row label="Stock Quantity" value={String(product.stockQuantity)} />
          <Row label="Internal Notes" value={product.internalNotes ?? "—"} />
        </div>

        <div className="noctella-panel" style={{ flex: 1, padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>AI-Generated Draft</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Title">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.generatedTitle}
                onChange={(e) => set("generatedTitle", e.target.value)}
              />
            </Field>
            <Field label="Description">
              <textarea
                style={{ ...inputStyle, minHeight: 80 }}
                disabled={!isEditable}
                value={fields.generatedDescription}
                onChange={(e) => set("generatedDescription", e.target.value)}
              />
            </Field>
            <Field label="Story">
              <textarea
                style={{ ...inputStyle, minHeight: 80 }}
                disabled={!isEditable}
                value={fields.generatedStory}
                onChange={(e) => set("generatedStory", e.target.value)}
              />
            </Field>
            <Field label="Condition Description">
              <textarea
                style={{ ...inputStyle, minHeight: 60 }}
                disabled={!isEditable}
                value={fields.generatedConditionDescription}
                onChange={(e) => set("generatedConditionDescription", e.target.value)}
              />
            </Field>
            <Field label="Suggested Category">
              <select
                style={inputStyle}
                disabled={!isEditable}
                value={fields.suggestedCategoryId}
                onChange={(e) => set("suggestedCategoryId", e.target.value)}
              >
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Suggested Collection">
              <select
                style={inputStyle}
                disabled={!isEditable}
                value={fields.suggestedCollectionId}
                onChange={(e) => set("suggestedCollectionId", e.target.value)}
              >
                <option value="">—</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Suggested EUR Price">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.suggestedEurPrice}
                onChange={(e) => set("suggestedEurPrice", e.target.value)}
              />
            </Field>
            <Field label="Suggested USD Price">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.suggestedUsdPrice}
                onChange={(e) => set("suggestedUsdPrice", e.target.value)}
              />
            </Field>
            <Field label="Minimum Offer Price">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.suggestedMinimumOfferPrice}
                onChange={(e) => set("suggestedMinimumOfferPrice", e.target.value)}
              />
            </Field>
            <Field label="SEO Title">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.seoTitle}
                onChange={(e) => set("seoTitle", e.target.value)}
              />
            </Field>
            <Field label="Meta Description">
              <textarea
                style={{ ...inputStyle, minHeight: 60 }}
                disabled={!isEditable}
                value={fields.metaDescription}
                onChange={(e) => set("metaDescription", e.target.value)}
              />
            </Field>
            <Field label="Keywords (comma-separated)">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.keywords}
                onChange={(e) => set("keywords", e.target.value)}
              />
            </Field>
            <Field label="Shipping Note">
              <input
                style={inputStyle}
                disabled={!isEditable}
                value={fields.shippingNote}
                onChange={(e) => set("shippingNote", e.target.value)}
              />
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                disabled={!isEditable}
                checked={fields.customsWarning}
                onChange={(e) => set("customsWarning", e.target.checked)}
              />
              Customs / import-duty warning
            </label>
          </div>
        </div>
      </div>

      {isEditable && (
        <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
          <button onClick={handleSave} disabled={busy !== null} style={primaryButtonStyle}>
            {busy === "save" ? "Saving..." : "Save Draft"}
          </button>
          <button onClick={handleApprove} disabled={busy !== null} style={primaryButtonStyle}>
            {busy === "approve" ? "Approving..." : "Approve"}
          </button>
          <button
            onClick={() => setShowRejectForm((v) => !v)}
            disabled={busy !== null}
            style={secondaryButtonStyle}
          >
            Reject
          </button>
          <button onClick={handleRegenerate} disabled={busy !== null} style={secondaryButtonStyle}>
            {busy === "regenerate" ? "Regenerating..." : "Regenerate"}
          </button>
        </div>
      )}

      {!isEditable && draft.status !== "rejected" && (
        <div style={{ marginTop: 24 }}>
          <button onClick={handleRegenerate} disabled={busy !== null} style={secondaryButtonStyle}>
            {busy === "regenerate" ? "Regenerating..." : "Regenerate"}
          </button>
        </div>
      )}

      {draft.status === "rejected" && (
        <div style={{ marginTop: 24 }}>
          <button onClick={handleRegenerate} disabled={busy !== null} style={primaryButtonStyle}>
            {busy === "regenerate" ? "Regenerating..." : "Regenerate"}
          </button>
        </div>
      )}

      {showRejectForm && (
        <div className="noctella-panel" style={{ marginTop: 16, padding: 16, maxWidth: 480 }}>
          <Field label="Rejection Reason (required)">
            <textarea
              style={{ ...inputStyle, minHeight: 60 }}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
            />
          </Field>
          <button
            onClick={handleReject}
            disabled={busy !== null || rejectionReason.trim().length === 0}
            style={{ ...primaryButtonStyle, marginTop: 12 }}
          >
            {busy === "reject" ? "Rejecting..." : "Confirm Reject"}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span style={{ textAlign: "right", maxWidth: "60%" }}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-night-navy)",
  border: "1px solid var(--noctella-aged-bronze)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
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

const secondaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  fontSize: 14,
  cursor: "pointer",
};
