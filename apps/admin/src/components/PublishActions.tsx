"use client";

import { PublishChannel, type MarketplaceConnection, type PublishPreview, type UnifiedPublishChannelResult } from "@noctella/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { ProductDetail } from "@/lib/types";
import { ADMIN_PUBLISH_CHANNELS, channelLabel, publishingApi, requiresMarketplaceConnection } from "@/lib/publishing";
import { marketplaceApi } from "@/lib/marketplaces";

interface PublishActionsProps {
  productId: string;
  /** Whether ProductForm's current visible values differ from its persisted baseline. */
  isDirty: boolean;
  /** ProductForm's own current canonical Product version - used as the batch's expectedUpdatedAt when the form is clean. */
  currentProductUpdatedAt?: string;
  /**
   * Sprint 146: performs the existing Product PUT (via EditProductPage's save-without-navigation
   * callback) using ProductForm's CURRENT visible values, and advances ProductForm's own visible
   * values/persisted baseline/version state on success. Any failure (including
   * PRODUCT_VERSION_CONFLICT) is already surfaced by ProductForm's own existing formError/
   * versionConflict UI - this component only needs the boolean outcome to decide whether to
   * proceed to executePublishBatch.
   */
  saveForPublish: () => Promise<{ ok: true; updatedAt: string } | { ok: false }>;
  /**
   * Sprint 146: called with the freshly re-fetched canonical Product after every successful (HTTP
   * 200, including partial-success) executePublishBatch response - ProductForm owns applying this
   * to its own visible values/persisted baseline/version state (see ProductForm.tsx's
   * applyRefreshedProduct).
   */
  onProductRefreshed: (product: ProductDetail) => void;
  /**
   * Sprint 147: fired only after a resolved (HTTP-success) executePublishBatch response has
   * already completed the canonical Product refetch and onProductRefreshed application above -
   * regardless of the resolved batch's per-channel outcomes (succeeded/failed/skipped/partial).
   * Never fired for a request-level rejection (PRODUCT_VERSION_CONFLICT, validation, auth,
   * network, or any other thrown error) or for a failed/aborted Save-before-Publish. This
   * component deliberately owns no navigation itself (Sprint 147 Option B) - EditProductPage
   * supplies this callback and performs the actual `router.push`.
   */
  onPublishComplete?: () => void;
}

/** Sprint 146: duplicated locally (not imported) from products/[id]/publishing/page.tsx's own unifiedOutcomeText - that file is explicitly required to remain unchanged as a legacy Operations/History surface, and it does not export this helper. */
function outcomeText(item: UnifiedPublishChannelResult): string {
  if (item.outcome === "succeeded") return "Published";
  if (item.outcome === "skipped") return "Already published";
  return `Failed: ${item.error?.message ?? "Unknown error"}`;
}

/**
 * Sprint 146: the canonical publish surface, composed INSIDE ProductForm (never a second `<form>`,
 * every button here is `type="button"`). Channel selection is checkboxes + one "Publish Selected"
 * action only - a one-channel publish is simply a one-element selection, never a separate
 * per-channel button. Reuses the existing executePublishBatch (now version-gated) and the existing
 * per-channel publish preview/validation read - never a new endpoint, never a second publishing
 * implementation.
 */
export function PublishActions({ productId, isDirty, currentProductUpdatedAt, saveForPublish, onProductRefreshed, onPublishComplete }: PublishActionsProps) {
  const [connections, setConnections] = useState<MarketplaceConnection[]>([]);
  const [previews, setPreviews] = useState<Partial<Record<PublishChannel, PublishPreview>>>({});
  const [selectedChannels, setSelectedChannels] = useState<Set<PublishChannel>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UnifiedPublishChannelResult[] | null>(null);

  const loadConnections = () => {
    marketplaceApi.listConnections().then(setConnections).catch(() => setConnections([]));
  };

  const loadPreviews = () => {
    for (const item of ADMIN_PUBLISH_CHANNELS) {
      publishingApi
        .getPreview(productId, item.value)
        .then((preview) => setPreviews((prev) => ({ ...prev, [item.value]: preview })))
        .catch(() => setPreviews((prev) => ({ ...prev, [item.value]: undefined })));
    }
  };

  useEffect(loadConnections, [productId]);
  useEffect(loadPreviews, [productId]);

  function toggleChannel(target: PublishChannel) {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }

  /**
   * Sprint 146: deterministic Save-before-Publish sequence. Dirty Product: Save first (using
   * ProductForm's CURRENT visible values), and only continue to executePublishBatch once that
   * Save genuinely succeeds - never on failure, never on PRODUCT_VERSION_CONFLICT (ProductForm's
   * own existing conflict UI already handles surfacing that, preserving local values and offering
   * the existing Reload Latest Product action; this function simply stops). Clean Product: no
   * redundant PUT - the current version token is used directly. After every successful HTTP
   * response (including partial success), the canonical Product is re-fetched and fed back into
   * ProductForm, and previews are refreshed against the now-current persisted state.
   *
   * Sprint 147: onPublishComplete fires as the LAST step, strictly after executePublishBatch has
   * resolved (never on a request-level rejection - PRODUCT_VERSION_CONFLICT, validation, auth,
   * network, or any other thrown error, all handled by the existing catch block below, which never
   * reaches this call) and strictly after the existing canonical Product refetch/onProductRefreshed
   * has already applied - regardless of what the resolved batch's per-channel outcomes actually
   * are. It never fires from the Save-before-Publish abort path above (`return` on `!saved.ok`
   * exits this function before executePublishBatch is ever called).
   */
  async function handlePublishSelected() {
    if (selectedChannels.size === 0) return;
    setPublishing(true);
    setError(null);
    try {
      let expectedUpdatedAt = currentProductUpdatedAt;
      if (isDirty) {
        const saved = await saveForPublish();
        if (!saved.ok) return; // ProductForm already surfaced the specific error/conflict UI
        expectedUpdatedAt = saved.updatedAt;
      }
      if (!expectedUpdatedAt) return; // defensive only - the Product version is always known once Edit has loaded

      const response = await marketplaceApi.executePublishBatch(productId, Array.from(selectedChannels), expectedUpdatedAt);
      setResults(response.results);

      // Sprint 146 Critical Correction 3: refetch the canonical Product after EVERY successful
      // HTTP response, including partial success - Noctella Web success may have changed
      // Product.status/updatedAt; eBay/Etsy never do, but refetching unconditionally keeps this
      // one deterministic rule rather than a channel-dependent special case.
      const refreshed = await api.get<ProductDetail>(`/api/products/${productId}`);
      onProductRefreshed(refreshed);
      loadPreviews();
      // Sprint 147: the publish attempt is now fully complete (batch resolved, canonical Product
      // refreshed and applied) - regardless of succeeded/failed/skipped/partial per-channel
      // content. Navigation itself is EditProductPage's responsibility; this component only
      // reports completion.
      onPublishComplete?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to publish selected channels");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div>
      {error && <p style={{ color: "#c86a6a", fontSize: 13 }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
        {ADMIN_PUBLISH_CHANNELS.map((item) => {
          const connection = connections.find((c) => c.channel === item.value);
          const disconnected = requiresMarketplaceConnection(item.value) && connection?.status !== "connected";
          const preview = previews[item.value];
          return (
            <div key={item.value} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={selectedChannels.has(item.value)} onChange={() => toggleChannel(item.value)} />
                  {item.label}
                </label>
                {/* UX guidance only - executePublish's own connection check server-side remains sole authority. */}
                {disconnected && <span style={{ fontSize: 11, color: "var(--noctella-aged-bronze)" }}>(disconnected)</span>}
                {preview && (
                  <span style={{ fontSize: 11, color: preview.validation.valid ? "var(--noctella-bright-star-gold)" : "#c86a6a" }}>
                    {preview.validation.valid ? "Ready to publish" : `${preview.validation.errors.length} issue(s)`}
                  </span>
                )}
              </span>
              {selectedChannels.has(item.value) && preview && !preview.validation.valid && (
                <ul style={{ margin: "0 0 0 24px", fontSize: 12, color: "#c86a6a" }}>
                  {preview.validation.errors.map((issue) => (
                    <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <button type="button" onClick={handlePublishSelected} disabled={publishing || selectedChannels.size === 0}>
        {publishing ? "Publishing..." : "Publish Selected"}
      </button>

      <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--noctella-aged-bronze)" }}>
        Manage eBay/Etsy connections on the{" "}
        <a href="/marketplaces" style={{ color: "var(--noctella-bright-star-gold)" }}>
          Marketplaces
        </a>{" "}
        page.
      </p>

      {results && (
        <ul style={{ marginTop: 12 }}>
          {results.map((item) => (
            <li key={item.channel}>
              {channelLabel(item.channel)} — {outcomeText(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
