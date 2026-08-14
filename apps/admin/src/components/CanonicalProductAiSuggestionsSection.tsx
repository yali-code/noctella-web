"use client";

import { CanonicalProductProposalStatus, type CanonicalProductProposal, type Product } from "@noctella/shared";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { canonicalProductProposalApi } from "@/lib/canonicalProductProposals";
import type { ProductFormValues } from "./ProductForm";

interface CanonicalProductAiSuggestionsSectionProps {
  productId: string;
  /** Read-only live ProductForm values - used only to compute current-vs-suggested display and safe default-selection; this component never writes to `values` itself. */
  values: ProductFormValues;
  /** Mirrors AiChannelSuggestionsSection's own client-side staleness hint - the authoritative freshness check always remains the accept endpoint's own server-side comparison. */
  productUpdatedAt?: string;
  /**
   * Fired only after a successful Accept, with exactly the Product field keys that were included
   * in that Accept request (never the full suggested set - only what was actually selected) and
   * whether any Marketing Tag was part of the request. ProductForm owns the narrow field-scoped
   * merge into `values`/`persistedBaseline` and the Marketing Tags refresh signal; this component
   * never touches either directly.
   */
  onApplied: (selectedProductFields: string[], marketingTagsChanged: boolean, product: Product) => void;
}

const PRODUCT_DETAIL_FIELDS: Array<{ key: string; label: string; multiline?: boolean }> = [
  { key: "brand", label: "Brand" },
  { key: "model", label: "Model" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "countryOfOrigin", label: "Country of Origin" },
  { key: "period", label: "Period / Estimated Production Date" },
  { key: "materials", label: "Materials" },
  { key: "description", label: "Description", multiline: true },
  { key: "productStory", label: "Product Story", multiline: true },
  { key: "condition", label: "Condition" },
  { key: "conditionDescription", label: "Condition Description", multiline: true },
];

const PHYSICAL_FIELDS: Array<{ key: string; label: string }> = [
  { key: "lengthValue", label: "Length" },
  { key: "widthValue", label: "Width" },
  { key: "heightValue", label: "Height" },
  { key: "dimensionUnit", label: "Dimension Unit" },
  { key: "weightValue", label: "Weight" },
  { key: "weightUnit", label: "Weight Unit" },
];

const ALL_FIELD_KEYS = [...PRODUCT_DETAIL_FIELDS, ...PHYSICAL_FIELDS].map((f) => f.key);

/** Reads the one suggested* field a canonical Product field key corresponds to - mirrors the server's own suggestedColumnFor(key) naming convention (use-cases/canonical-product-proposal/useCases.ts). */
function suggestionValueFor(proposal: CanonicalProductProposal, key: string): string | undefined {
  switch (key) {
    case "brand": return proposal.suggestedBrand;
    case "model": return proposal.suggestedModel;
    case "manufacturer": return proposal.suggestedManufacturer;
    case "countryOfOrigin": return proposal.suggestedCountryOfOrigin;
    case "period": return proposal.suggestedPeriod;
    case "materials": return proposal.suggestedMaterials;
    case "description": return proposal.suggestedDescription;
    case "productStory": return proposal.suggestedProductStory;
    case "condition": return proposal.suggestedCondition;
    case "conditionDescription": return proposal.suggestedConditionDescription;
    case "lengthValue": return proposal.suggestedLengthValue?.toString();
    case "widthValue": return proposal.suggestedWidthValue?.toString();
    case "heightValue": return proposal.suggestedHeightValue?.toString();
    case "dimensionUnit": return proposal.suggestedDimensionUnit;
    case "weightValue": return proposal.suggestedWeightValue?.toString();
    case "weightUnit": return proposal.suggestedWeightUnit;
    default: return undefined;
  }
}

function currentValueFor(values: ProductFormValues, key: string): string {
  const raw = (values as unknown as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

/**
 * Sprint 148: the canonical (non-channel) AI Suggestions panel - Product Details, Physical
 * Information, and Marketing Tags in one review surface, mounted inside ProductForm after
 * Physical Information and before the eBay/Etsy/Noctella Web sections (Architecture Review item
 * B). Mirrors AiChannelSuggestionsSection's proven NONE/PENDING+FRESH/PENDING+STALE/APPLIED state
 * machine and Generate/Regenerate/Accept mental model exactly, but is NOT a generalization of that
 * component - it targets a structurally different, non-channel-scoped proposal (see Sprint 148
 * Architecture Review Option B) and adds the selective-Accept review UI that component doesn't
 * need (channel Accept always applies every suggested field for that channel; canonical Accept
 * never does).
 *
 * Selective Accept default-selection rule (Architecture Review item J), applied uniformly to
 * every Product Details/Physical Information field: a field is selected by default only when its
 * CURRENT live ProductForm value is blank - an existing human value (whether identical to or
 * different from the suggestion) is never selected by default, so Accept can never silently
 * overwrite it. Marketing Tags are additive-only (never delete/replace), so every suggested tag
 * is selected by default. "Newer local edit protection": a field auto-selected because it was
 * blank is automatically deselected the moment its live value becomes non-blank (the user typed
 * something before clicking Accept) - an explicit user click on any checkbox permanently marks
 * that field as a deliberate choice, no longer subject to that automatic revocation.
 */
export function CanonicalProductAiSuggestionsSection({ productId, values, productUpdatedAt, onApplied }: CanonicalProductAiSuggestionsSectionProps) {
  const [proposal, setProposal] = useState<CanonicalProductProposal | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  const autoSelectedKeysRef = useRef<Set<string>>(new Set());
  const initializedForProposalId = useRef<string | null>(null);

  const load = () => {
    setError(null);
    canonicalProductProposalApi
      .get(productId)
      .then((loaded) => setProposal(loaded))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setProposal(null); // NONE state - not an error.
          return;
        }
        setError(err instanceof ApiError ? err.message : "Failed to load AI Product Suggestions");
      })
      .finally(() => setChecked(true));
  };

  useEffect(load, [productId]);

  const isStale =
    !!proposal &&
    proposal.status === CanonicalProductProposalStatus.Pending &&
    productUpdatedAt !== undefined &&
    proposal.baseProductUpdatedAt !== productUpdatedAt;

  // Initialize safe default selection exactly once per newly (re)generated proposal - never
  // re-derived on every keystroke (that would fight a user's own explicit toggles).
  useEffect(() => {
    if (!proposal || proposal.status !== CanonicalProductProposalStatus.Pending || isStale) return;
    if (initializedForProposalId.current === proposal.id) return;
    initializedForProposalId.current = proposal.id;

    const defaults = new Set<string>();
    for (const key of ALL_FIELD_KEYS) {
      if (suggestionValueFor(proposal, key) === undefined) continue;
      if (currentValueFor(values, key).trim() === "") defaults.add(key);
    }
    autoSelectedKeysRef.current = new Set(defaults);
    setSelectedFields(defaults);
    setSelectedTags(new Set(proposal.suggestedMarketingTags ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, isStale]);

  // Newer local edit protection: revoke only the auto-selected (because-blank) keys whose live
  // value has since become non-blank. Explicit user toggles (see toggleField) are never touched
  // here, since a direct toggle immediately removes that key from autoSelectedKeysRef.
  useEffect(() => {
    if (autoSelectedKeysRef.current.size === 0) return;
    setSelectedFields((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of Array.from(autoSelectedKeysRef.current)) {
        if (currentValueFor(values, key).trim() !== "") {
          next.delete(key);
          autoSelectedKeysRef.current.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [values]);

  function toggleField(key: string) {
    autoSelectedKeysRef.current.delete(key); // any direct click is now a deliberate, sticky choice
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleTag(label: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const loaded = await canonicalProductProposalApi.generate(productId);
      initializedForProposalId.current = null; // force fresh default-selection for the new proposal
      setProposal(loaded);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate AI Product Suggestions");
    } finally {
      setGenerating(false);
    }
  }

  async function handleAccept() {
    if (!proposal || proposal.status !== CanonicalProductProposalStatus.Pending || isStale) return;
    const fields = Array.from(selectedFields);
    const tags = Array.from(selectedTags);
    if (fields.length === 0 && tags.length === 0) return;

    setAccepting(true);
    setError(null);
    try {
      const updatedProduct = await canonicalProductProposalApi.accept(productId, {
        expectedProposalUpdatedAt: proposal.updatedAt,
        selectedProductFields: fields,
        selectedMarketingTags: tags,
      });
      onApplied(fields, tags.length > 0, updatedProduct);
      load(); // refresh this panel's own proposal state (now "applied") - independent of ProductForm's values.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to accept AI Product Suggestions");
    } finally {
      setAccepting(false);
    }
  }

  if (!checked) {
    return <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>Loading AI Product Suggestions...</p>;
  }

  const nothingSelected = selectedFields.size === 0 && selectedTags.size === 0;

  function renderFieldRow(field: { key: string; label: string; multiline?: boolean }) {
    if (!proposal) return null;
    const suggested = suggestionValueFor(proposal, field.key);
    if (suggested === undefined) return null;
    const current = currentValueFor(values, field.key);
    return (
      <div key={field.key} style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={selectedFields.has(field.key)}
            onChange={() => toggleField(field.key)}
            disabled={isStale}
          />
          {/* Deliberately not just field.label - a bare "Brand"/"Model"/etc. would collide with the
              actual Product Details/Physical Information input's own identical accessible name
              (getByLabelText("Brand") would become ambiguous), both here and for real screen-reader
              users navigating a form with two same-named controls. */}
          Apply {field.label} suggestion
        </label>
        <dl style={{ margin: "0 0 0 22px", fontSize: 12 }}>
          <div>
            <dt style={{ color: "var(--noctella-aged-bronze)", display: "inline" }}>Current: </dt>
            <dd style={{ display: "inline", margin: 0 }}>{current || "(empty)"}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--noctella-bright-star-gold)", display: "inline" }}>Suggested: </dt>
            <dd style={{ display: "inline", margin: 0, whiteSpace: field.multiline ? "pre-wrap" : "normal" }}>{suggested}</dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <div className="noctella-panel" style={{ padding: 12, marginTop: 8 }}>
      <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 600, color: "var(--noctella-bright-star-gold)" }}>
        AI Product Suggestions
      </p>
      {error && <p style={{ color: "#c86a6a", fontSize: 12 }}>{error}</p>}

      {!proposal && (
        <>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
            No AI Product Suggestions generated yet.
          </p>
          <button type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating..." : "Generate AI Suggestions"}
          </button>
        </>
      )}

      {proposal && proposal.status === CanonicalProductProposalStatus.Applied && (
        <>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>AI Product Suggestions Applied.</p>
          <button type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating..." : "Regenerate AI Suggestions"}
          </button>
        </>
      )}

      {proposal && proposal.status === CanonicalProductProposalStatus.Pending && (
        <>
          {isStale ? (
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#c86a6a" }}>
              This suggestion is based on an earlier version of this Product. Regenerate before it can be accepted.
            </p>
          ) : (
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
              Review the AI suggestions below, select the fields to apply, then Accept. Fields with an existing
              value are never pre-selected - select them explicitly to replace that value.
            </p>
          )}

          {PRODUCT_DETAIL_FIELDS.some((f) => suggestionValueFor(proposal, f.key) !== undefined) && (
            <fieldset style={{ border: "none", padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: 0 }}>Product Details</legend>
              {PRODUCT_DETAIL_FIELDS.map(renderFieldRow)}
            </fieldset>
          )}

          {PHYSICAL_FIELDS.some((f) => suggestionValueFor(proposal, f.key) !== undefined) && (
            <fieldset style={{ border: "none", padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: 0 }}>Physical Information</legend>
              {PHYSICAL_FIELDS.map(renderFieldRow)}
            </fieldset>
          )}

          {proposal.suggestedMarketingTags && proposal.suggestedMarketingTags.length > 0 && (
            <fieldset style={{ border: "none", padding: 0, margin: "0 0 12px" }}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: 0 }}>Marketing Tags (adds only - existing tags are always preserved)</legend>
              {proposal.suggestedMarketingTags.map((tag) => (
                <label key={tag} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 4 }}>
                  <input type="checkbox" checked={selectedTags.has(tag)} onChange={() => toggleTag(tag)} disabled={isStale} />
                  {tag}
                </label>
              ))}
            </fieldset>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={handleAccept} disabled={accepting || isStale || nothingSelected}>
              {accepting ? "Accepting..." : "Accept AI Suggestions"}
            </button>
            <button type="button" onClick={handleGenerate} disabled={generating}>
              {generating ? "Regenerating..." : "Regenerate AI Suggestions"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
