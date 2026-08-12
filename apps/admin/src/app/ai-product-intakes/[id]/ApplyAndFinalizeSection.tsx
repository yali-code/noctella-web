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
import { useRouter } from "next/navigation";
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

/** Empty-string form fields are sent as undefined, never as "" - mirrors the validation schema's optional().trim().min(1) contract. */
function toOptionalField(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Sprint 137: warehouse-facing Stock Acceptance. Price is deliberately absent from this form
 * entirely - the warehouse must never enter, and this component never sends, a sales price (see
 * Product.priceEur's own nullable doc comment in @noctella/shared and
 * validation/aiIntakeStockAcceptance.ts's now-optional priceEur). Category and Type remain the
 * only required fields; Quantity/Brand/Model/Condition are shown as useful physical/factual
 * fields; every Admin/marketplace-preparation field (manufacturer, country of origin, period,
 * materials, condition description, SEO title, meta description) is tucked behind one collapsed
 * "More details (optional)" disclosure so the warehouse operator's primary path stays short.
 *
 * Sprint 97/106 (unchanged): Stock Acceptance (canonical Product/Inventory write, SKU is
 * system-generated - never entered here) and Finalize (canonical ProductPhoto write) remain two
 * separate backend transactions - Sprint 137 does not merge them. What changes is orchestration:
 * a successful Stock Acceptance now automatically chains a Finalize call (using the existing
 * default-to-first-staged-photo behavior, since this simplified flow has no primary-photo
 * picker) before navigating to the Stock Receipt/label route - the operator no longer sees a
 * separate manual "Finalize Photos" step on the happy path. If Finalize fails after Stock
 * Acceptance already succeeded, this never re-runs Stock Acceptance (no duplicate Product/SKU),
 * never fabricates a failure of the already-successful accept, and exposes a minimal
 * "Retry photo finalization" recovery action instead.
 */
export function ApplyAndFinalizeSection({ intakeId, intake, photos, proposal, onIntakeChanged, onPhotosReload }: Props) {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [type, setType] = useState<string>(ProductType.UniqueItem);
  const [stockQuantity, setStockQuantity] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [condition, setCondition] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [countryOfOrigin, setCountryOfOrigin] = useState("");
  const [period, setPeriod] = useState("");
  const [materials, setMaterials] = useState("");
  const [conditionDescription, setConditionDescription] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  /** Sprint 137: the productId returned by a successful Stock Acceptance in THIS session - used
   * to navigate to the label route without waiting for an intake reload round-trip. */
  const [acceptedProductId, setAcceptedProductId] = useState<string | null>(null);

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
    setBrand((prev) => prev || proposal.suggestedBrand || "");
    setModel((prev) => prev || proposal.suggestedModel || "");
    setCondition((prev) => prev || proposal.suggestedCondition || "");
    setManufacturer((prev) => prev || proposal.suggestedManufacturer || "");
    setCountryOfOrigin((prev) => prev || proposal.suggestedCountryOfOrigin || "");
    setPeriod((prev) => prev || proposal.suggestedPeriod || "");
    setMaterials((prev) => prev || proposal.suggestedMaterials || "");
    setConditionDescription((prev) => prev || proposal.suggestedConditionDescription || "");
    setSeoTitle((prev) => prev || proposal.suggestedSeoTitle || "");
    setMetaDescription((prev) => prev || proposal.suggestedMetaDescription || "");
  }, [proposal]);

  /** Sprint 137: reuses the existing finalize-photos contract unchanged - omitting
   * primaryIntakePhotoId relies on its existing default-to-first-staged-photo behavior. */
  async function runFinalize(productId: string) {
    setFinalizing(true);
    setFinalizeError(null);
    try {
      await aiProductIntakesApi.finalizePhotos(intakeId);
      await onPhotosReload();
      await onIntakeChanged();
      router.push(`/products/${productId}/label`);
    } catch (err) {
      setFinalizeError(err instanceof ApiError ? err.message : "Failed to finalize photos");
    } finally {
      setFinalizing(false);
    }
  }

  async function handleAcceptIntoStock() {
    if (!proposal) return;
    setError(null);
    setAccepting(true);
    try {
      const product = await aiProductIntakesApi.acceptIntoStock(intakeId, {
        categoryId,
        type,
        stockQuantity: stockQuantity ? Number(stockQuantity) : undefined,
        brand: toOptionalField(brand),
        model: toOptionalField(model),
        condition: toOptionalField(condition),
        manufacturer: toOptionalField(manufacturer),
        countryOfOrigin: toOptionalField(countryOfOrigin),
        period: toOptionalField(period),
        materials: toOptionalField(materials),
        conditionDescription: toOptionalField(conditionDescription),
        seoTitle: toOptionalField(seoTitle),
        metaDescription: toOptionalField(metaDescription),
        expectedProposalUpdatedAt: proposal.updatedAt,
      });
      setConfirmAccept(false);
      setAcceptedProductId(product.id);
      await onIntakeChanged();
      await runFinalize(product.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to accept into stock");
    } finally {
      setAccepting(false);
    }
  }

  // Sprint 137: also hidden once this session has already accepted (acceptedProductId set) even if
  // the intake prop's status hasn't caught up to "Applied" yet - see needsFinalizeRetry below for
  // why that prop can lag behind local state immediately after a successful accept.
  const canAccept = intake.status === AiProductIntakeStatus.Open && acceptedProductId === null;
  // Sprint 137: Applied means Stock Acceptance already succeeded but Finalize has not completed -
  // either the automatic chain above is still running (finalizing) or a prior attempt failed
  // (finalizeError) or this page was reloaded after leaving that state. Never re-runs Stock
  // Acceptance from here - only the Finalize step is retryable. Checks acceptedProductId (this
  // session's own just-succeeded accept) in addition to the intake prop's own status, since the
  // parent only re-fetches/re-renders with the fresh intake after `onIntakeChanged()` resolves -
  // there is a real, brief window where Finalize has already failed locally but that prop update
  // has not landed yet; without this, the recovery UI could fail to appear at exactly the moment
  // it is needed.
  const needsFinalizeRetry = intake.status === AiProductIntakeStatus.Applied || acceptedProductId !== null;
  const retryProductId = acceptedProductId ?? intake.resultProductId ?? null;

  return (
    <div className="noctella-panel" style={{ padding: 20, marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>Stock Acceptance</h3>
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}

      {canAccept && (
        <div style={{ marginBottom: 20 }}>
          {!proposal && <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>Generate and review a proposal first.</p>}
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            The Product SKU and barcode are generated automatically. No sales price is entered here - Admin assigns it later.
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
            <input
              placeholder={type === ProductType.UniqueItem ? "Quantity (1 - Unique Item)" : "Quantity"}
              value={stockQuantity}
              onChange={(e) => setStockQuantity(e.target.value)}
              disabled={type === ProductType.UniqueItem}
              style={inputStyle}
            />
            <input placeholder="Brand (optional)" value={brand} onChange={(e) => setBrand(e.target.value)} style={inputStyle} />
            <input placeholder="Model (optional)" value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle} />
            <input placeholder="Condition (optional)" value={condition} onChange={(e) => setCondition(e.target.value)} style={inputStyle} />

            <details>
              <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>More details (optional)</summary>
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                <input
                  placeholder="Manufacturer (optional)"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="Country of origin (optional)"
                  value={countryOfOrigin}
                  onChange={(e) => setCountryOfOrigin(e.target.value)}
                  style={inputStyle}
                />
                <input placeholder="Period (optional)" value={period} onChange={(e) => setPeriod(e.target.value)} style={inputStyle} />
                <input placeholder="Materials (optional)" value={materials} onChange={(e) => setMaterials(e.target.value)} style={inputStyle} />
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
            </details>
          </div>
          {confirmAccept ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 12 }}>Accept this item into stock?</p>
              <button
                onClick={handleAcceptIntoStock}
                disabled={accepting || finalizing || !proposal || !categoryId}
                style={primaryButtonStyle}
              >
                {accepting ? "Accepting..." : finalizing ? "Finalizing photos..." : "Confirm Stock Acceptance"}
              </button>{" "}
              <button onClick={() => setConfirmAccept(false)} disabled={accepting || finalizing} style={secondaryButtonStyle}>
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

      {needsFinalizeRetry && (
        <div>
          <h4>Finish Stock Acceptance</h4>
          <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            The Product was created, but canonical photos could not be finalized yet.
          </p>
          {finalizeError && <p style={{ color: "#c86a6a" }}>{finalizeError}</p>}
          {photos.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>No staged photos to finalize.</p>
          ) : (
            <button
              onClick={() => retryProductId && runFinalize(retryProductId)}
              disabled={finalizing || !retryProductId}
              style={primaryButtonStyle}
            >
              {finalizing ? "Finalizing..." : "Retry photo finalization"}
            </button>
          )}
        </div>
      )}

      {intake.resultProductId && (
        <p style={{ marginTop: 16 }}>
          <Link href={`/products/${intake.resultProductId}`} style={{ color: "var(--noctella-ivory)" }}>
            View Product →
          </Link>
          {intake.status === AiProductIntakeStatus.Finalized && (
            <>
              {" · "}
              <Link href={`/products/${intake.resultProductId}/label`} style={{ color: "var(--noctella-ivory)" }}>
                View Stock Label →
              </Link>
            </>
          )}
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
