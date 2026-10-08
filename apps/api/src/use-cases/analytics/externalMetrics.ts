/**
 * Analytics Stage 3A: external platform metrics ingestion contract. Collectors (eBay first; Etsy,
 * Instagram, Pinterest later) return provider observations; this pure module validates and
 * normalizes them into analytics_metric_snapshots rows with sourceType "external_platform".
 * External metrics are historical observations only - never written to operational marketplace
 * tables, never zero-filled, and never converted between cumulative and interval semantics.
 */

/**
 * Provider window semantics, persisted with every row. Deltas between snapshots are a later phase
 * and are only meaningful for "cumulative_lifetime" metrics.
 */
export type ExternalWindowSemantics = "cumulative_lifetime" | "rolling_window" | "fixed_range" | "daily";
/** "provider_defined": the provider does not document the scale (e.g. eBay traffic-report rates) - stored as given, never rescaled. */
export type ExternalMetricUnit = "count" | "percent" | "ratio" | "eur" | "provider_defined";

export interface ExternalMetricObservation {
  /** listing (marketplaces), media (Instagram), pin (Pinterest). Stored as scope_type external_<entityType>. */
  readonly entityType: "listing" | "media" | "pin";
  readonly externalEntityId: string;
  /** Stable Noctella key, e.g. "listing_impressions". Stored in namespace = platform. */
  readonly metricKey: string;
  /** Provider's own metric identifier, kept for provenance. */
  readonly providerMetric: string;
  /** null = the provider did not supply a value (stored as unknown, never 0). */
  readonly value: number | null;
  readonly unit: ExternalMetricUnit;
  readonly windowSemantics: ExternalWindowSemantics;
}

export interface ExternalCollectionResult {
  readonly platform: string;
  /** Provider endpoint/version, e.g. a documented report name - stored as source_reference. */
  readonly sourceReference: string;
  /** The time the metrics represent (provider window end, or the observation instant). */
  readonly observedAt: string;
  /** Provider window, null for point-in-time/lifetime values. */
  readonly window: { readonly start: string; readonly end: string } | null;
  readonly observations: readonly ExternalMetricObservation[];
  readonly warnings: readonly string[];
}

export interface ExternalCollectorContext {
  readonly connectionId: string;
  /** Decrypted provider token - must never be logged, persisted or put into a snapshot. */
  readonly accessToken: string;
  readonly now: Date;
}

/** One platform collector. Must call only documented provider APIs (no scraping/browser automation). */
export interface ExternalAnalyticsCollector {
  readonly platform: string;
  collect(context: ExternalCollectorContext): Promise<ExternalCollectionResult>;
}

export type ExternalCollectorErrorKind = "authentication" | "permission" | "rate_limit" | "temporary" | "malformed_payload" | "not_connected" | "not_configured" | "request_rejected";

/** Typed collector failure - the run is recorded as failed and no metric rows are written. */
export class ExternalCollectorError extends Error {
  constructor(readonly kind: ExternalCollectorErrorKind, message: string) {
    super(message);
    this.name = "ExternalCollectorError";
  }
}

/** Deterministic entity -> product link plus non-secret provenance (e.g. socialContentId, publishedAt). Never guessed. */
export interface ExternalEntityLink { readonly productId: string | null; readonly context: Readonly<Record<string, unknown>> }

export interface ExternalSnapshotRow {
  readonly scopeType: "external_listing" | "external_media" | "external_pin";
  readonly scopeId: string;
  readonly metricNamespace: string;
  readonly metricKey: string;
  readonly numericValue: number | null;
  readonly textValue: null;
  readonly valueState: "known" | "unknown";
  readonly unit: ExternalMetricUnit;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Idempotency identity of one collector run: platform + account/connection + observation/window. */
export function externalRunIdempotencyKey(platform: string, connectionId: string, result: Pick<ExternalCollectionResult, "observedAt" | "window" | "sourceReference">): string {
  const window = result.window ? `${result.window.start}..${result.window.end}` : "point";
  return `external:${platform}:${connectionId}:${result.sourceReference}:${window}:${result.observedAt}`;
}

const WINDOW_SEMANTICS = new Set<ExternalWindowSemantics>(["cumulative_lifetime", "rolling_window", "fixed_range", "daily"]);

/**
 * Validates and normalizes a collector result. Listings are scoped by platform + external id;
 * the product id comes only from the existing external_listings mapping (never guessed) and is
 * kept in metadata - unmapped listings are still stored (product null) with a warning.
 * A malformed observation (non-finite value, unknown window semantics, missing id/key) rejects the
 * whole result rather than storing partial or fabricated data.
 */
export function normalizeExternalCollection(
  result: ExternalCollectionResult,
  connectionId: string,
  productByListingId: ReadonlyMap<string, string>,
  entityLinks: ReadonlyMap<string, ExternalEntityLink> = new Map(),
): { rows: ExternalSnapshotRow[]; warnings: string[] } {
  if (!result.platform || !result.sourceReference || Number.isNaN(new Date(result.observedAt).getTime())) {
    throw new ExternalCollectorError("malformed_payload", "Collector result is missing platform, source reference or a valid observedAt");
  }
  const warnings = [...result.warnings];
  const unmapped = new Map<string, string>();
  const seen = new Set<string>();
  const rows: ExternalSnapshotRow[] = [];
  for (const o of result.observations) {
    if (!o.externalEntityId || !o.metricKey || !o.providerMetric || !WINDOW_SEMANTICS.has(o.windowSemantics) || (o.value !== null && !Number.isFinite(o.value))) {
      throw new ExternalCollectorError("malformed_payload", "Collector returned a malformed metric observation");
    }
    const identity = `${o.externalEntityId}|${o.metricKey}`;
    if (seen.has(identity)) throw new ExternalCollectorError("malformed_payload", `Duplicate observation for ${o.metricKey} on one listing`);
    seen.add(identity);
    const link = entityLinks.get(o.externalEntityId);
    const productId = link?.productId ?? productByListingId.get(o.externalEntityId) ?? null;
    if (!productId) unmapped.set(o.externalEntityId, o.entityType);
    rows.push({
      scopeType: `external_${o.entityType}`,
      scopeId: `${result.platform}:${o.externalEntityId}`,
      metricNamespace: result.platform,
      metricKey: o.metricKey,
      numericValue: o.value,
      textValue: null,
      valueState: o.value === null ? "unknown" : "known",
      unit: o.unit,
      metadata: {
        platform: result.platform,
        connectionId,
        ...(o.entityType === "listing" ? { externalListingId: o.externalEntityId } : { externalEntityId: o.externalEntityId }),
        productId,
        ...(link?.context ?? {}),
        providerMetric: o.providerMetric,
        windowSemantics: o.windowSemantics,
        window: result.window,
      },
    });
  }
  for (const [id, type] of [...unmapped].sort(([a], [b]) => a.localeCompare(b))) warnings.push(`UNMAPPED_${type.toUpperCase()}:${result.platform}:${id}`);
  return { rows, warnings };
}
