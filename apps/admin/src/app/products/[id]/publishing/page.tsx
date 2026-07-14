"use client";

import { PUBLISH_CHANNEL_VALUES, PublishChannel, type PublishPreview, type PublishValidation } from "@noctella/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { issueMessages, publishingApi, readinessByChannel } from "@/lib/publishing";

export default function ProductPublishingPage({ params }: { params: { id: string } }) {
  const [channel, setChannel] = useState<PublishChannel>(PublishChannel.NoctellaWeb);
  const [readiness, setReadiness] = useState<Record<string, PublishValidation>>({});
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    publishingApi
      .summary(params.id)
      .then((summary) => setReadiness(readinessByChannel(summary)))
      .catch((err) => setError(err.message ?? "Failed to load publishing readiness"))
      .finally(() => setLoading(false));
  }, [params.id]);

  async function refreshValidation(nextChannel = channel) {
    setPreview(null);
    const validation = await publishingApi.validate(params.id, nextChannel);
    setReadiness((current) => ({ ...current, [nextChannel]: validation }));
  }

  async function buildPreview() {
    setError(null);
    setPreview(null);
    try {
      setPreview(await publishingApi.preview(params.id, channel));
      await refreshValidation(channel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      await refreshValidation(channel).catch(() => {});
    }
  }

  const current = readiness[channel];

  return (
    <div>
      <Link href={`/products/${params.id}`}>← Back to product</Link>
      <h1>Publishing</h1>
      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading publishing readiness...</p>}
      {error && <p style={{ color: "#c86a6a" }}>{error}</p>}
      {!loading && (
        <div className="noctella-panel" style={{ padding: 20, display: "grid", gap: 16 }}>
          <label style={{ display: "grid", gap: 6 }}>
            Channel
            <select
              value={channel}
              onChange={async (event) => {
                const nextChannel = event.target.value as PublishChannel;
                setChannel(nextChannel);
                await refreshValidation(nextChannel);
              }}
              style={{ padding: 10 }}
            >
              {PUBLISH_CHANNEL_VALUES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {current ? (
            <section>
              <h2>{current.isReady ? "Ready" : "Not ready"}</h2>
              <IssueList title="Errors" items={issueMessages(current, "errors")} />
              <IssueList title="Warnings" items={issueMessages(current, "warnings")} />
            </section>
          ) : (
            <p>No readiness information is available for this channel.</p>
          )}
          <button type="button" onClick={buildPreview} disabled={!current?.isReady}>
            Build Preview
          </button>
          {preview && (
            <section style={{ borderTop: "1px solid var(--noctella-aged-bronze)", paddingTop: 16 }}>
              <h2>Preview</h2>
              <p><strong>Title:</strong> {preview.title}</p>
              {preview.subtitle && <p><strong>Subtitle:</strong> {preview.subtitle}</p>}
              <p><strong>Price:</strong> {preview.currency} {preview.price.toFixed(2)}</p>
              <p><strong>Category:</strong> {preview.category ?? "—"}</p>
              <p><strong>SKU:</strong> {preview.sku}</p>
              <p><strong>Stock:</strong> {preview.stock}</p>
              <p><strong>Photos:</strong> {preview.photos.length}</p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function IssueList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length === 0 ? <p>None</p> : <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>}
    </div>
  );
}
