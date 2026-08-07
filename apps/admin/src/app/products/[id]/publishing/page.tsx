"use client";

import { PublishChannel, type ExternalListing, type MarketplaceConnection, type MarketplacePreparation, type PublishJob, type PublishPreview } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { ADMIN_PUBLISH_CHANNELS, channelLabel, marketplacePreparationApi, payloadSummary, publishingApi, requiresMarketplaceConnection } from "@/lib/publishing";
import { canRetry, externalListingLink, marketplaceApi, safeError } from "@/lib/marketplaces";

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

  const load = () => {
    setError(null);
    publishingApi.getPreview(params.id, channel).then(setPreview).catch((err) => setError(err.message ?? "Failed to load publishing preview"));
    marketplaceApi.listConnections().then((items) => setConnection(items.find((c) => c.channel === channel) ?? null)).catch(() => setConnection(null));
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

  useEffect(load, [params.id, channel]);
  useEffect(loadPreparation, [params.id, channel]);

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

  return (
    <div>
      <Link href={`/products/${params.id}`} style={{ color: "var(--noctella-bright-star-gold)" }}>← Back to product</Link>
      <h1>Publishing</h1>
      <select value={channel} onChange={(event) => setChannel(event.target.value as PublishChannel)} style={{ padding: 10, marginBottom: 16 }}>
        {ADMIN_PUBLISH_CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      {error && <p style={{ color: "#c86a6a" }}>{safeError(error)}</p>}

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

      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}><h2>Connection</h2>{connectionRequired ? <><p>Status: {connection?.status ?? "disconnected"}</p><p>Expiry: {connection?.tokenExpiresAt ?? "—"}</p></> : <p>Direct channel — no external connection required.</p>}</section>
      {preview && <div className="noctella-panel" style={{ padding: 20 }}><h2>{channelLabel(preview.channel)} validation</h2><p>{preview.validation.valid ? "Ready to publish payload." : "Resolve validation errors before publishing."}</p><h3>Errors</h3>{preview.validation.errors.length === 0 ? <p>No blocking errors.</p> : <ul>{preview.validation.errors.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}<h3>Warnings</h3>{preview.validation.warnings.length === 0 ? <p>No warnings.</p> : <ul>{preview.validation.warnings.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}<h3>Preview payload</h3><p>{payloadSummary(preview.payload)}</p><button disabled={disabled} onClick={() => marketplaceApi.executePublish(params.id, channel).then(load).catch((e)=>setError(e.message))}>Execute Publish</button></div>}
      <section><h2>External listings</h2>{listings.map((l)=><p key={l.id}>{l.channel}: {l.externalListingUrl ? <a href={l.externalListingUrl}>{l.externalListingId}</a> : externalListingLink(l)} ({l.externalStatus})</p>)}</section>
      <section><h2>Publish history</h2>{jobs.map((j)=><p key={j.id}><Link href={`/publish-jobs/${j.id}`}>{j.status}</Link> attempts {j.attemptCount} {j.externalListingId ?? ""} {canRetry(j) && <button onClick={()=>marketplaceApi.retry(j.id).then(load)}>Retry</button>}</p>)}</section>
    </div>
  );
}
