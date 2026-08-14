"use client";

import { PublishChannel, type ExternalListing, type MarketplaceConnection, type PublishJob } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ADMIN_PUBLISH_CHANNELS, requiresMarketplaceConnection } from "@/lib/publishing";
import { canRetry, externalListingLink, marketplaceApi } from "@/lib/marketplaces";

/**
 * Sprint 146: Publication Operations / History.
 *
 * Every Product-editing and publish-initiation responsibility this page used to own has moved
 * into the canonical Product Edit workspace (/products/:id/edit - ProductForm composes
 * AiChannelSuggestionsSection for AI Suggestions, MarketingTagsSection for Product Marketing Tags,
 * and PublishActions for channel selection + Publish Selected, which now performs
 * Save-before-Publish and requires the current Product version on every batch request):
 *   - canonical Price editing (Sprint 140) - now ProductForm's own EUR Price field.
 *   - Product Marketing Tags editing (Sprint 140/144) - now MarketingTagsSection.
 *   - Marketplace Preparation Generate/Regenerate/edit/Approve (Sprint 107/145) - now
 *     AiChannelSuggestionsSection.
 *   - single-channel Execute Publish and the Sprint 141 unified Publish Selected - now
 *     PublishActions.
 *
 * This route is intentionally NOT described as read-only - Retry below is a genuine operational
 * mutation. It remains a Publication Operations / History surface: marketplace Connection status,
 * External Listings, and Publish History (with Retry), none of which are Product-editing concerns
 * and none of which need to live inside ProductForm (per the established "one form does not
 * require every specialized operational tool" principle - see Sprint 144's Photos precedent).
 */
export default function ProductPublishingPage({ params }: { params: { id: string } }) {
  const [channel, setChannel] = useState<PublishChannel>(PublishChannel.Ebay);
  const [connection, setConnection] = useState<MarketplaceConnection | null>(null);
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [listings, setListings] = useState<ExternalListing[]>([]);

  const load = () => {
    marketplaceApi
      .listConnections()
      .then((items) => setConnection(items.find((c) => c.channel === channel) ?? null))
      .catch(() => setConnection(null));
    marketplaceApi
      .listJobs()
      .then((items) => setJobs(items.filter((j) => j.productId === params.id && j.channel === channel)))
      .catch(() => setJobs([]));
    marketplaceApi.externalListings(params.id).then(setListings).catch(() => setListings([]));
  };

  useEffect(load, [params.id, channel]);

  const connectionRequired = requiresMarketplaceConnection(channel);

  return (
    <div>
      <Link href={`/products/${params.id}`} style={{ color: "var(--noctella-bright-star-gold)" }}>← Back to product</Link>
      <h1>Publication Operations / History</h1>
      <p>
        <Link href={`/products/${params.id}/edit`} style={{ color: "var(--noctella-bright-star-gold)" }}>Edit Product</Link>
        {" "}— Product editing, AI Suggestions, Marketing Tags, and Publish Selected all live in the canonical Edit workspace.
      </p>
      <select value={channel} onChange={(event) => setChannel(event.target.value as PublishChannel)} style={{ padding: 10, marginBottom: 16 }}>
        {ADMIN_PUBLISH_CHANNELS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}>
        <h2>Connection</h2>
        {connectionRequired ? (
          <>
            <p>Status: {connection?.status ?? "disconnected"}</p>
            <p>Expiry: {connection?.tokenExpiresAt ?? "—"}</p>
          </>
        ) : (
          <p>Direct channel — no external connection required.</p>
        )}
      </section>
      <section>
        <h2>External listings</h2>
        {listings.map((l) => (
          <p key={l.id}>
            {l.channel}: {l.externalListingUrl ? <a href={l.externalListingUrl}>{l.externalListingId}</a> : externalListingLink(l)} ({l.externalStatus})
          </p>
        ))}
      </section>
      <section>
        <h2>Publish history</h2>
        {jobs.map((j) => (
          <p key={j.id}>
            <Link href={`/publish-jobs/${j.id}`}>{j.status}</Link> attempts {j.attemptCount} {j.externalListingId ?? ""}{" "}
            {canRetry(j) && <button onClick={() => marketplaceApi.retry(j.id).then(load)}>Retry</button>}
          </p>
        ))}
      </section>
    </div>
  );
}
