"use client";

import { PublishChannel, type ExternalListing, type MarketingTag, type MarketplaceConnection, type MarketplacePreparation, type PublishJob, type PublishPreview, type UnifiedPublishChannelResult } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { ProductDetail } from "@/lib/types";
import { ADMIN_PUBLISH_CHANNELS, channelLabel, marketplacePreparationApi, payloadSummary, publishingApi, requiresMarketplaceConnection } from "@/lib/publishing";
import { canRetry, externalListingLink, marketplaceApi, safeError } from "@/lib/marketplaces";
import { marketingTagsApi } from "@/lib/marketingTags";

/**
 * Sprint 107: which of Marketplace Preparation's twelve possible suggestion
 * fields are relevant for a given channel, and the plain-text label to show
 * for each - mirrors use-cases/marketplace-preparation/useCases.ts's
 * mapApprovedFieldsToProductValues exactly (the same field set, the same
 * per-channel scoping). "tags" is edited as a comma-separated string in the
 * UI and split into an array only at submit time.
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
    { key: "tags", label: "Tags (comma-separated)" },
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
};

function suggestionValue(preparation: MarketplacePreparation, key: string): string {
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

/** Sprint 141: truthful per-channel outcome text for the unified publish result list. */
function unifiedOutcomeText(item: UnifiedPublishChannelResult): string {
  if (item.outcome === "succeeded") return "Published";
  if (item.outcome === "skipped") return "Already published";
  return `Failed: ${item.error?.message ?? "Unknown error"}`;
}

export default function ProductPublishingPage({ params }: { params: { id: string } }) {
  const [channel, setChannel] = useState<PublishChannel>(PublishChannel.Ebay);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [connection, setConnection] = useState<MarketplaceConnection | null>(null);
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [listings, setListings] = useState<ExternalListing[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Sprint 107: Marketplace Preparation state - deliberately separate from `preview` above. The
  // AI proposal is never silently applied to the Product; only an explicit "Approve" writes it,
  // and only "Execute Publish" (unchanged, existing button) ever publishes anything.
  const [preparation, setPreparation] = useState<MarketplacePreparation | null>(null);
  const [preparationChecked, setPreparationChecked] = useState(false);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);

  // Sprint 140: canonical price editor state - deliberately channel-agnostic (no per-channel AI
  // pricing authority), independent of the Marketplace Preparation Approve action above. Reuses
  // the existing PUT /api/products/:id endpoint with a minimal partial body, preserving optimistic
  // concurrency via expectedUpdatedAt exactly like Product Edit already does.
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [priceExpectedUpdatedAt, setPriceExpectedUpdatedAt] = useState<string | null>(null);
  const [savingPrice, setSavingPrice] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Sprint 140: Product Marketing Tags - a distinct concept from this page's existing per-channel
  // Marketplace Preparation content, loaded/edited independently via the explicit GET/POST/DELETE
  // Marketing Tags endpoints (no replace-all call).
  const [tags, setTags] = useState<MarketingTag[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [newTagLabel, setNewTagLabel] = useState("");
  const [addingTag, setAddingTag] = useState(false);

  // Sprint 141: unified channel selection & publish - page-global, transient client state only
  // (never persisted, never a Product column), fully independent of the `channel` dropdown state
  // above so switching the dropdown never clears it during the current page session. `connections`
  // reuses the exact same listConnections() call `load()` already makes - no new connection API.
  const [connections, setConnections] = useState<MarketplaceConnection[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<Set<PublishChannel>>(new Set());
  const [publishingSelected, setPublishingSelected] = useState(false);
  const [unifiedResults, setUnifiedResults] = useState<UnifiedPublishChannelResult[] | null>(null);
  const [unifiedError, setUnifiedError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    publishingApi.getPreview(params.id, channel).then(setPreview).catch((err) => setError(err.message ?? "Failed to load publishing preview"));
    marketplaceApi
      .listConnections()
      .then((items) => {
        setConnections(items);
        setConnection(items.find((c) => c.channel === channel) ?? null);
      })
      .catch(() => {
        setConnections([]);
        setConnection(null);
      });
    marketplaceApi.listJobs().then((items) => setJobs(items.filter((j) => j.productId === params.id && j.channel === channel))).catch(() => setJobs([]));
    marketplaceApi.externalListings(params.id).then(setListings).catch(() => setListings([]));
  };

  const loadPreparation = () => {
    setPreparationChecked(false);
    setPreparationError(null);
    marketplacePreparationApi
      .get(params.id, channel)
      .then((loaded) => {
        setPreparation(loaded);
        setFieldValues(Object.fromEntries(CHANNEL_FIELDS[channel].map((field) => [field.key, suggestionValue(loaded, field.key)])));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setPreparation(null);
          setFieldValues({});
          return;
        }
        setPreparationError(err instanceof ApiError ? err.message : "Failed to load marketplace preparation");
      })
      .finally(() => setPreparationChecked(true));
  };

  // Sprint 140: fetches the canonical Product directly (never through the per-channel
  // Marketplace Preparation state above) - the source for the price editor's current value and
  // its expectedUpdatedAt version token.
  const loadProduct = () => {
    api
      .get<ProductDetail>(`/api/products/${params.id}`)
      .then((loaded) => {
        setProduct(loaded);
        setPriceInput(loaded.priceEur != null ? String(loaded.priceEur) : "");
        setPriceExpectedUpdatedAt(loaded.updatedAt);
      })
      .catch((err) => setPriceError(err instanceof ApiError ? err.message : "Failed to load Product price"));
  };

  const loadTags = () => {
    setTagsError(null);
    marketingTagsApi
      .list(params.id)
      .then(setTags)
      .catch((err) => setTagsError(err instanceof ApiError ? err.message : "Failed to load Marketing Tags"));
  };

  useEffect(load, [params.id, channel]);
  useEffect(loadPreparation, [params.id, channel]);
  useEffect(loadProduct, [params.id]);
  useEffect(loadTags, [params.id]);

  const connectionRequired = requiresMarketplaceConnection(channel);
  const connected = connection?.status === "connected";
  const disabled = !preview?.validation.valid || (connectionRequired && !connected);

  async function handleGenerate() {
    setGenerating(true);
    setPreparationError(null);
    try {
      const loaded = await marketplacePreparationApi.generate(params.id, channel);
      setPreparation(loaded);
      setFieldValues(Object.fromEntries(CHANNEL_FIELDS[channel].map((field) => [field.key, suggestionValue(loaded, field.key)])));
    } catch (err) {
      setPreparationError(err instanceof ApiError ? err.message : "Failed to generate marketplace preparation");
    } finally {
      setGenerating(false);
    }
  }

  async function handleApprove() {
    if (!preparation) return;
    setApproving(true);
    setPreparationError(null);
    try {
      await marketplacePreparationApi.approve(params.id, {
        channel,
        expectedProposalUpdatedAt: preparation.updatedAt,
        ...Object.fromEntries(
          CHANNEL_FIELDS[channel].map((field) => [
            field.key,
            field.key === "tags"
              ? fieldValues[field.key]?.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
              : fieldValues[field.key]?.trim() || undefined,
          ]),
        ),
      });
      loadPreparation();
      load(); // the approved fields now live on the Product - refresh the publish preview/validation too
    } catch (err) {
      setPreparationError(err instanceof ApiError ? err.message : "Failed to approve marketplace preparation");
    } finally {
      setApproving(false);
    }
  }

  /**
   * Sprint 140: an independent, narrow action - deliberately not coupled to Marketplace
   * Preparation Approve above. Sends only the minimum partial body (priceEur + the existing
   * expectedUpdatedAt version token), preserving optimistic concurrency exactly like Product Edit
   * already does. An empty input clears the canonical price back to null, matching the existing
   * server-side contract (a Draft/Approved Product may have no price) rather than inventing a
   * client-only rule against it.
   */
  async function handleSavePrice() {
    setSavingPrice(true);
    setPriceError(null);
    try {
      const trimmed = priceInput.trim();
      const priceEur = trimmed === "" ? null : Number(trimmed);
      const updated = await api.put<ProductDetail>(`/api/products/${params.id}`, { priceEur, expectedUpdatedAt: priceExpectedUpdatedAt });
      setProduct(updated);
      setPriceInput(updated.priceEur != null ? String(updated.priceEur) : "");
      // Sprint 140: the version token must be refreshed after every successful save, never
      // silently discarded - the next edit must compare against the Product's now-current
      // updatedAt, not the stale value this save was itself validated against.
      setPriceExpectedUpdatedAt(updated.updatedAt);
    } catch (err) {
      setPriceError(err instanceof ApiError ? err.message : "Failed to save price");
    } finally {
      setSavingPrice(false);
    }
  }

  async function handleAddTag() {
    const label = newTagLabel.trim();
    if (!label) return;
    setAddingTag(true);
    setTagsError(null);
    try {
      await marketingTagsApi.add(params.id, label);
      setNewTagLabel("");
      loadTags();
    } catch (err) {
      setTagsError(err instanceof ApiError ? err.message : "Failed to add Marketing Tag");
    } finally {
      setAddingTag(false);
    }
  }

  async function handleRemoveTag(tagId: string) {
    setTagsError(null);
    try {
      await marketingTagsApi.remove(params.id, tagId);
      loadTags();
    } catch (err) {
      setTagsError(err instanceof ApiError ? err.message : "Failed to remove Marketing Tag");
    }
  }

  function toggleChannel(target: PublishChannel) {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }

  /**
   * Sprint 141: one batch request for every selected channel - never three separate calls to the
   * old single-channel endpoint. Delegates entirely to the existing authoritative executePublish
   * via the new backend batch endpoint; this handler only submits the selection and renders the
   * truthful per-channel results it gets back. No idempotency key is ever sent.
   */
  async function handlePublishSelected() {
    if (selectedChannels.size === 0) return;
    setPublishingSelected(true);
    setUnifiedError(null);
    try {
      const response = await marketplaceApi.executePublishBatch(params.id, Array.from(selectedChannels));
      setUnifiedResults(response.results);
      load(); // a selected channel's publish may have changed durable state (Product.status, ExternalListings, PublishJobs)
    } catch (err) {
      setUnifiedError(err instanceof ApiError ? err.message : "Failed to publish selected channels");
    } finally {
      setPublishingSelected(false);
    }
  }

  return (
    <div>
      <Link href={`/products/${params.id}`} style={{ color: "var(--noctella-bright-star-gold)" }}>← Back to product</Link>
      <h1>Publishing</h1>
      {/* Sprint 112: moved out of the {preview && ...} block below - the required-but-still-manual
          channel fields (eBay category, eBay/Etsy/Noctella Web listing price) this link exists for
          must remain reachable even when the publish preview itself fails to load. */}
      <p><Link href={`/products/${params.id}/edit`} style={{ color: "var(--noctella-bright-star-gold)" }}>Edit Product</Link></p>
      <select value={channel} onChange={(event) => setChannel(event.target.value as PublishChannel)} style={{ padding: 10, marginBottom: 16 }}>
        {ADMIN_PUBLISH_CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      {error && <p style={{ color: "#c86a6a" }}>{safeError(error)}</p>}

      {/* Sprint 141: unified channel selection & publish - page-global, independent of the channel
          dropdown above (which continues to drive Preview/Prepare/Regenerate/Approve/Connection for
          one channel at a time). Delegates every selected channel to the existing, unmodified
          Execute Publish authority via one batch request - never a second publishing implementation. */}
      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}>
        <h2>Publish to Multiple Channels</h2>
        {/* Rendered raw, not through safeError - matching preparationError/priceError/tagsError's
            own established convention on this page: this is our own typed products.publish JSON
            response error, never a raw marketplace OAuth/connection error. safeError's blunt
            6-plus-character redaction would otherwise mangle ordinary words in a plain message. */}
        {unifiedError && <p style={{ color: "#c86a6a" }}>{unifiedError}</p>}
        <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
          {ADMIN_PUBLISH_CHANNELS.map((item) => {
            const channelConnection = connections.find((c) => c.channel === item.value);
            // UX guidance only - the backend's own connection check inside executePublish remains
            // sole authority; this never disables the checkbox, only hints at a likely outcome.
            const disconnected = requiresMarketplaceConnection(item.value) && channelConnection?.status !== "connected";
            // The "(disconnected)" hint is rendered as a sibling OUTSIDE <label>, deliberately -
            // inside it, the hint text would be folded into the checkbox's own accessible name
            // (e.g. "eBay(disconnected)"), which is neither correct a11y nor a stable name to
            // target from the checkbox itself.
            return (
              <span key={item.value} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={selectedChannels.has(item.value)} onChange={() => toggleChannel(item.value)} />
                  {item.label}
                </label>
                {disconnected && <span style={{ fontSize: 11, color: "var(--noctella-aged-bronze)" }}>(disconnected)</span>}
              </span>
            );
          })}
        </div>
        <button onClick={handlePublishSelected} disabled={publishingSelected || selectedChannels.size === 0}>
          {publishingSelected ? "Publishing..." : "Publish Selected"}
        </button>
        {unifiedResults && (
          <ul style={{ marginTop: 12 }}>
            {unifiedResults.map((item) => (
              <li key={item.channel}>
                {channelLabel(item.channel)} — {unifiedOutcomeText(item)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}>
        <h2>Marketplace Preparation</h2>
        {/* Sprint 107: rendered raw, not through safeError - these are our own typed, non-secret
            conflict/validation messages (never a marketplace OAuth/connection error, the concern
            safeError's token-redaction regex exists for). */}
        {preparationError && <p style={{ color: "#c86a6a" }}>{preparationError}</p>}
        {!preparationChecked ? (
          <p>Loading...</p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
              {preparation
                ? `Status: ${preparation.status}. Review and edit the AI's suggestions below, then Approve to update the ${channelLabel(channel)} fields on this Product.`
                : "No marketplace preparation exists yet for this channel."}
            </p>
            <button onClick={handleGenerate} disabled={generating} style={{ marginBottom: 12 }}>
              {generating ? "Preparing..." : preparation ? "Regenerate with AI" : "Prepare with AI"}
            </button>
            {preparation && (
              <div style={{ display: "grid", gap: 8, maxWidth: 480 }}>
                {CHANNEL_FIELDS[channel].map((field) =>
                  field.multiline ? (
                    <textarea
                      key={field.key}
                      placeholder={field.label}
                      value={fieldValues[field.key] ?? ""}
                      onChange={(event) => setFieldValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                      rows={3}
                    />
                  ) : (
                    <input
                      key={field.key}
                      placeholder={field.label}
                      value={fieldValues[field.key] ?? ""}
                      onChange={(event) => setFieldValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    />
                  ),
                )}
                <button onClick={handleApprove} disabled={approving || preparation.status !== "pending"}>
                  {approving ? "Approving..." : "Approve Marketplace Preparation"}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Sprint 140: channel-agnostic - a single canonical price, never a per-channel AI pricing
          authority. Independent of Marketplace Preparation Approve above; saving here never
          touches eBay/Etsy/Web listing-specific price overrides. */}
      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}>
        <h2>Price</h2>
        {priceError && <p style={{ color: "#c86a6a" }}>{priceError}</p>}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="No price set"
            value={priceInput}
            onChange={(event) => setPriceInput(event.target.value)}
            style={{ maxWidth: 160 }}
          />
          <button onClick={handleSavePrice} disabled={savingPrice || !product}>
            {savingPrice ? "Saving..." : "Save Price"}
          </button>
        </div>
      </section>

      {/* Sprint 140: Product Marketing Tags - distinct from Product Category, SEO keywords, and
          the per-channel Etsy tags edited above. Explicit add/remove only. */}
      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}>
        <h2>Marketing Tags</h2>
        {tagsError && <p style={{ color: "#c86a6a" }}>{tagsError}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {tags.length === 0 && <p style={{ margin: 0, color: "var(--noctella-aged-bronze)" }}>No Marketing Tags yet.</p>}
          {tags.map((tag) => (
            <span key={tag.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", border: "1px solid var(--noctella-antique-gold)", borderRadius: 999 }}>
              {tag.label}
              <button onClick={() => handleRemoveTag(tag.id)} aria-label={`Remove ${tag.label}`} style={{ border: "none", background: "none", cursor: "pointer" }}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            placeholder="e.g. Father's Day"
            value={newTagLabel}
            onChange={(event) => setNewTagLabel(event.target.value)}
          />
          <button onClick={handleAddTag} disabled={addingTag || !newTagLabel.trim()}>
            {addingTag ? "Adding..." : "Add Tag"}
          </button>
        </div>
      </section>

      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}><h2>Connection</h2>{connectionRequired ? <><p>Status: {connection?.status ?? "disconnected"}</p><p>Expiry: {connection?.tokenExpiresAt ?? "—"}</p></> : <p>Direct channel — no external connection required.</p>}</section>
      {preview && <div className="noctella-panel" style={{ padding: 20 }}><h2>{channelLabel(preview.channel)} validation</h2><p>{preview.validation.valid ? "Ready to publish payload." : "Resolve validation errors before publishing."}</p><h3>Errors</h3>{preview.validation.errors.length === 0 ? <p>No blocking errors.</p> : <ul>{preview.validation.errors.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}<h3>Warnings</h3>{preview.validation.warnings.length === 0 ? <p>No warnings.</p> : <ul>{preview.validation.warnings.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}<h3>Preview payload</h3><p>{payloadSummary(preview.payload)}</p><button disabled={disabled} onClick={() => marketplaceApi.executePublish(params.id, channel).then(load).catch((e)=>setError(e.message))}>Execute Publish</button></div>}
      <section><h2>External listings</h2>{listings.map((l)=><p key={l.id}>{l.channel}: {l.externalListingUrl ? <a href={l.externalListingUrl}>{l.externalListingId}</a> : externalListingLink(l)} ({l.externalStatus})</p>)}</section>
      <section><h2>Publish history</h2>{jobs.map((j)=><p key={j.id}><Link href={`/publish-jobs/${j.id}`}>{j.status}</Link> attempts {j.attemptCount} {j.externalListingId ?? ""} {canRetry(j) && <button onClick={()=>marketplaceApi.retry(j.id).then(load)}>Retry</button>}</p>)}</section>
    </div>
  );
}
