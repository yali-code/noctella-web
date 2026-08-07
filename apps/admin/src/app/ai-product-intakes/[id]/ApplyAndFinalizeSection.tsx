"use client";

import {
  AiProductIntakeStatus,
  ProductType,
  type AiIntakePhoto,
  type AiIntakeProposalReview,
  type AiProductIntake,
  type Category,
} from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { aiProductIntakesApi } from "@/lib/aiProductIntakes";
import type { PaginatedResult } from "@/lib/types";

interface Props {
  intakeId: string;
  intake: AiProductIntake;
  photos: AiIntakePhoto[];
  proposal: AiIntakeProposalReview | null;
  onIntakeChanged: () => Promise<AiProductIntake>;
  onPhotosReload: () => Promise<AiIntakePhoto[]>;
}

/**
 * Sprint 99: immediate client-side check before Stock Acceptance - the backend remains
 * authoritative (this never replaces its validation, only avoids an unnecessary round trip for an
 * obviously invalid value). priceEur is required; stockQuantity is optional but, when provided,
 * must be a non-negative integer. Never coerces - an invalid value blocks submission with a
 * message shown through the component's existing error area, not silently rounded/clamped.
 */
function validatePriceAndStockFields(priceEur: string, stockQuantity: string): string | null {
  if (priceEur.trim() === "") return "Price (EUR) is required.";
  const price = Number(priceEur);
  if (!Number.isFinite(price) || price < 0) return "Price (EUR) must be a number greater than or equal to 0.";
  if (stockQuantity.trim() !== "") {
    const stock = Number(stockQuantity);
    if (!Number.isFinite(stock) || !Number.isInteger(stock) || stock < 0) {
      return "Stock quantity must be a whole number greater than or equal to 0.";
    }
  }
  return null;
}

/** Empty-string form fields are sent as undefined, never as "" - mirrors the validation schema's optional().trim().min(1) contract. */
function toOptionalField(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Sprint 97/106: Stock Acceptance (canonical Product/Inventory write, SKU is
 * system-generated - never entered here) and Finalize (canonical ProductPhoto
 * write) - both explicit, human-confirmed, never automatic. The AI's Full
 * Product Analysis suggestions (proposal.suggestedX) pre-fill the optional
 * fields below exactly once each (only while the admin has not yet typed a
 * value of their own) so every value remains admin-reviewable/editable before
 * Stock Acceptance, never silently trusted. Primary selection always
 * initializes to the first ordered staged photo and is always sent explicitly
 * on Finalize - never relies on backend omission fallback.
 */
export function ApplyAndFinalizeSection({ intakeId, intake, photos, proposal, onIntakeChanged, onPhotosReload }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [type, setType] = useState<string>(ProductType.UniqueItem);
  const [priceEur, setPriceEur] = useState("");
  const [stockQuantity, setStockQuantity] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [countryOfOrigin, setCountryOfOrigin] = useState("");
  const [period, setPeriod] = useState("");
  const [materials, setMaterials] = useState("");
  const [condition, setCondition] = useState("");
  const [conditionDescription, setConditionDescription] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  useEffect(() => {
    api
      .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
      .then((res) => setCategories(res.items))
      .catch(() => {});
  }, []);

  // Pre-fills from the AI's suggestions only while the admin has not yet
  // entered a value of their own (prev is empty) - never overwrites an
  // in-progress edit if the proposal reference changes again later.
  useEffect(() => {
    if (!proposal) return;
    setCategoryId((prev) => prev || proposal.suggestedCategoryId || "");
    setPriceEur((prev) => (prev ? prev : proposal.suggestedPriceEur !== undefined ? String(proposal.suggestedPriceEur) : ""));
    setBrand((prev) => prev || proposal.suggestedBrand || "");
    setModel((prev) => prev || proposal.suggestedModel || "");
    setManufacturer((prev) => prev || proposal.suggestedManufacturer || "");
    setCountryOfOrigin((prev) => prev || proposal.suggestedCountryOfOrigin || "");
    setPeriod((prev) => prev || proposal.suggestedPeriod || "");
    setMaterials((prev) => prev || proposal.suggestedMaterials || "");
    setCondition((prev) => prev || proposal.suggestedCondition || "");
    setConditionDescription((prev) => prev || proposal.suggestedConditionDescription || "");
    setSeoTitle((prev) => prev || proposal.suggestedSeoTitle || "");
    setMetaDescription((prev) => prev || proposal.suggestedMetaDescription || "");
  }, [proposal]);

  useEffect(() => {
    if (photos.length === 0) {
      setSelectedPhotoId(null);
      return;
    }
    setSelectedPhotoId((prev) => (prev && photos.some((p) => p.id === prev) ? prev : photos[0].id));
  }, [photos]);

  async function handleAcceptIntoStock() {
    if (!proposal) return;
    setError(null);
    const validationError = validatePriceAndStockFields(priceEur, stockQuantity);
    if (validationError) {
      setError(validationError);
      return;
    }
    setAccepting(true);
    try {
      await aiProductIntakesApi.acceptIntoStock(intakeId, {
        categoryId,
        type,
        priceEur: Number(priceEur),
        stockQuantity: stockQuantity ? Number(stockQuantity) : undefined,
        brand: toOptionalField(brand),
        model: toOptionalField(model),
        manufacturer: toOptionalField(manufacturer),
        countryOfOrigin: toOptionalField(countryOfOrigin),
        period: toOptionalField(period),
        materials: toOptionalField(materials),
        condition: toOptionalField(condition),
        conditionDescription: toOptionalField(conditionDescription),
        seoTitle: toOptionalField(seoTitle),
        metaDescription: toOptionalField(metaDescription),
        expectedProposalUpdatedAt: proposal.updatedAt,
      });
      setConfirmAccept(false);
      await onIntakeChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to accept into stock");
    } finally {
      setAccepting(false);
    }
  }

  async function handleFinalize() {
    if (!selectedPhotoId) return;
    setFinalizing(true);
    setError(null);
    try {
      await aiProductIntakesApi.finalizePhotos(intakeId, selectedPhotoId);
      setConfirmFinalize(false);
      await onIntakeChanged();
      await onPhotosReload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to finalize photos");
    } finally {
      setFinalizing(false);
    }
  }

  const canAccept = intake.status === AiProductIntakeStatus.Open;
  const canFinalize = intake.status === AiProductIntakeStatus.Applied;
  const showPrimarySection = canFinalize || intake.status === AiProductIntakeStatus.Finalized;

  return (
    <div className="noctella-panel" style={{ padding: 20, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Stock Acceptance and Finalize</h3>
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      {canAccept && (
        <div style={{ marginBottom: 20 }}>
          <h4>Stock Acceptance</h4>
          {!proposal && <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>Generate and review a proposal first.</p>}
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            The Product SKU and barcode are generated automatically. Review and edit the AI&apos;s suggestions below before accepting.
          </p>
          <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={inputStyle}>
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
              {Object.values(ProductType).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input placeholder="Price (EUR)" value={priceEur} onChange={(e) => setPriceEur(e.target.value)} style={inputStyle} />
            <input placeholder="Stock quantity (optional)" value={stockQuantity} onChange={(e) => setStockQuantity(e.target.value)} style={inputStyle} />
            <input placeholder="Brand (optional)" value={brand} onChange={(e) => setBrand(e.target.value)} style={inputStyle} />
            <input placeholder="Model (optional)" value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle} />
            <input placeholder="Manufacturer (optional)" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} style={inputStyle} />
            <input
              placeholder="Country of origin (optional)"
              value={countryOfOrigin}
              onChange={(e) => setCountryOfOrigin(e.target.value)}
              style={inputStyle}
            />
            <input placeholder="Period (optional)" value={period} onChange={(e) => setPeriod(e.target.value)} style={inputStyle} />
            <input placeholder="Materials (optional)" value={materials} onChange={(e) => setMaterials(e.target.value)} style={inputStyle} />
            <input placeholder="Condition (optional)" value={condition} onChange={(e) => setCondition(e.target.value)} style={inputStyle} />
            <input
              placeholder="Condition description (optional)"
              value={conditionDescription}
              onChange={(e) => setConditionDescription(e.target.value)}
              style={inputStyle}
            />
            <input placeholder="SEO title (optional)" value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} style={inputStyle} />
            <input
              placeholder="Meta description (optional)"
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              style={inputStyle}
            />
          </div>
          {confirmAccept ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12 }}>Create this Product in Stock?</p>
              <button onClick={handleAcceptIntoStock} disabled={accepting || !proposal || !categoryId || !priceEur} style={primaryButtonStyle}>
                {accepting ? "Accepting..." : "Confirm Stock Acceptance"}
              </button>{" "}
              <button onClick={() => setConfirmAccept(false)} style={secondaryButtonStyle}>
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmAccept(true)} disabled={!proposal} style={{ ...primaryButtonStyle, marginTop: 8 }}>
              Accept into Stock
            </button>
          )}
        </div>
      )}

      {showPrimarySection && (
        <div>
          <h4>Primary Photo and Finalize</h4>
          {photos.length === 0 && <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>No staged photos to finalize.</p>}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {photos.map((photo) => (
              <label key={photo.id} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="radio"
                  name="primary-photo"
                  checked={selectedPhotoId === photo.id}
                  onChange={() => setSelectedPhotoId(photo.id)}
                  disabled={!canFinalize}
                />
                {photo.originalFilename} {selectedPhotoId === photo.id ? "(Primary)" : ""}
              </label>
            ))}
          </div>
          {canFinalize &&
            (confirmFinalize ? (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: 12 }}>Finalize photos using the selected Primary?</p>
                <button onClick={handleFinalize} disabled={finalizing || !selectedPhotoId} style={primaryButtonStyle}>
                  {finalizing ? "Finalizing..." : "Confirm Finalize"}
                </button>{" "}
                <button onClick={() => setConfirmFinalize(false)} style={secondaryButtonStyle}>
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmFinalize(true)} disabled={!selectedPhotoId} style={{ ...primaryButtonStyle, marginTop: 8 }}>
                Finalize Photos
              </button>
            ))}
        </div>
      )}

      {intake.resultProductId && (
        <p style={{ marginTop: 16 }}>
          <Link href={`/products/${intake.resultProductId}`} style={{ color: "var(--noctella-ivory)" }}>
            View Product →
          </Link>
        </p>
      )}
    </div>
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
  padding: "6px 10px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  cursor: "pointer",
};
