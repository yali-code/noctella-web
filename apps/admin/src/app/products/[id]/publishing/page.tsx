"use client";

import { PublishChannel, type PublishPreview } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ADMIN_PUBLISH_CHANNELS, channelLabel, payloadSummary, publishingApi } from "@/lib/publishing";

export default function ProductPublishingPage({ params }: { params: { id: string } }) {
  const [channel, setChannel] = useState<PublishChannel>(PublishChannel.Ebay);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    publishingApi.getPreview(params.id, channel).then(setPreview).catch((err) => setError(err.message ?? "Failed to load publishing preview"));
  }, [params.id, channel]);

  return (
    <div>
      <Link href={`/products/${params.id}`} style={{ color: "var(--noctella-bright-star-gold)" }}>← Back to product</Link>
      <h1>Publishing</h1>
      <select value={channel} onChange={(event) => setChannel(event.target.value as PublishChannel)} style={{ padding: 10, marginBottom: 16 }}>
        {ADMIN_PUBLISH_CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      {!preview && !error && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading...</p>}
      {preview && (
        <div className="noctella-panel" style={{ padding: 20 }}>
          <h2>{channelLabel(preview.channel)} validation</h2>
          <p>{preview.validation.valid ? "Ready to publish payload." : "Resolve validation errors before publishing."}</p>
          <h3>Errors</h3>
          {preview.validation.errors.length === 0 ? <p>No blocking errors.</p> : <ul>{preview.validation.errors.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}
          <h3>Warnings</h3>
          {preview.validation.warnings.length === 0 ? <p>No warnings.</p> : <ul>{preview.validation.warnings.map((item) => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}</ul>}
          <h3>Preview payload</h3>
          <p>{payloadSummary(preview.payload)}</p>
        </div>
      )}
    </div>
  );
}
