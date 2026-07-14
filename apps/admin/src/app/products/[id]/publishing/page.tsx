"use client";

import { PublishChannel, type ExternalListing, type MarketplaceConnection, type PublishJob, type PublishPreview } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ADMIN_PUBLISH_CHANNELS, channelLabel, payloadSummary, publishingApi } from "@/lib/publishing";
import { canRetry, externalListingLink, marketplaceApi, safeError } from "@/lib/marketplaces";

export default function ProductPublishingPage({ params }: { params: { id: string } }) {
  const [channel, setChannel] = useState<PublishChannel>(PublishChannel.Ebay);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [connection, setConnection] = useState<MarketplaceConnection | null>(null);
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [listings, setListings] = useState<ExternalListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    publishingApi.getPreview(params.id, channel).then(setPreview).catch((err) => setError(err.message ?? "Failed to load publishing preview"));
    marketplaceApi.listConnections().then((items) => setConnection(items.find((c) => c.channel === channel) ?? null)).catch(() => setConnection(null));
    marketplaceApi.listJobs().then((items) => setJobs(items.filter((j) => j.productId === params.id && j.channel === channel))).catch(() => setJobs([]));
    marketplaceApi.externalListings(params.id).then(setListings).catch(() => setListings([]));
  };
  useEffect(load, [params.id, channel]);
  const connected = connection?.status === "connected";
  const disabled = !preview?.validation.valid || !connected;
  return (
    <div>
      <Link href={`/products/${params.id}`} style={{ color: "var(--noctella-bright-star-gold)" }}>← Back to product</Link>
      <h1>Publishing</h1>
      <select value={channel} onChange={(event) => setChannel(event.target.value as PublishChannel)} style={{ padding: 10, marginBottom: 16 }}>
        {ADMIN_PUBLISH_CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      {error && <p style={{ color: "#c86a6a" }}>{safeError(error)}</p>}
      <section className="noctella-panel" style={{ padding: 20, marginBottom: 16 }}><h2>Connection</h2><p>Status: {connection?.status ?? "disconnected"}</p><p>Expiry: {connection?.tokenExpiresAt ?? "—"}</p></section>
      {preview && <div className="noctella-panel" style={{ padding: 20 }}><h2>{channelLabel(preview.channel)} validation</h2><p>{preview.validation.valid ? "Ready to publish payload." : "Resolve validation errors before publishing."}</p><h3>Errors</h3>{preview.validation.errors.length === 0 ? <p>No blocking errors.</p> : <ul>{preview.validation.errors.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}<h3>Warnings</h3>{preview.validation.warnings.length === 0 ? <p>No warnings.</p> : <ul>{preview.validation.warnings.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}<h3>Preview payload</h3><p>{payloadSummary(preview.payload)}</p><button disabled={disabled} onClick={() => marketplaceApi.executePublish(params.id, channel).then(load).catch((e)=>setError(e.message))}>Execute Publish</button></div>}
      <section><h2>External listings</h2>{listings.map((l)=><p key={l.id}>{l.channel}: {l.externalListingUrl ? <a href={l.externalListingUrl}>{l.externalListingId}</a> : externalListingLink(l)} ({l.externalStatus})</p>)}</section>
      <section><h2>Publish history</h2>{jobs.map((j)=><p key={j.id}><Link href={`/publish-jobs/${j.id}`}>{j.status}</Link> attempts {j.attemptCount} {j.externalListingId ?? ""} {canRetry(j) && <button onClick={()=>marketplaceApi.retry(j.id).then(load)}>Retry</button>}</p>)}</section>
    </div>
  );
}
