import { ExternalCollectorError, type ExternalAnalyticsCollector, type ExternalCollectionResult, type ExternalCollectorContext, type ExternalMetricObservation } from "../../use-cases/analytics/externalMetrics";
import { InstagramClient } from "./InstagramClient";
import { InstagramClientError, type InstagramTransport } from "./types";

/**
 * Analytics Stage 3: Instagram media Insights collector (Instagram API with Instagram Login,
 * GET graph.instagram.com/<version>/<media-id>/insights; permissions instagram_business_basic +
 * instagram_business_manage_insights). Meta fixes period = lifetime, so every value is a
 * cumulative lifetime figure as of the collection time - stored with windowSemantics
 * "cumulative_lifetime"; no deltas are computed. Deprecated metrics (impressions, plays) are not
 * requested. If Meta rejects the combined metric request, each metric is retried alone once and
 * any metric Meta still rejects is recorded as unknown (null) with a warning - never zero.
 */

export const INSTAGRAM_MEDIA_INSIGHT_METRICS: readonly { readonly provider: string; readonly key: string }[] = Object.freeze([
  { provider: "views", key: "media_views" },
  { provider: "reach", key: "media_reach" },
  { provider: "likes", key: "media_likes" },
  { provider: "comments", key: "media_comments" },
  { provider: "saved", key: "media_saves" },
  { provider: "shares", key: "media_shares" },
  { provider: "total_interactions", key: "media_total_interactions" },
]);

export interface InstagramInsightsMedia { readonly mediaId: string }

function toCollectorError(error: unknown): ExternalCollectorError {
  if (error instanceof ExternalCollectorError) return error;
  if (!(error instanceof InstagramClientError)) return new ExternalCollectorError("temporary", "Instagram Insights request failed");
  if (error.kind === "authentication") return new ExternalCollectorError("authentication", "Instagram rejected the access token");
  if (error.kind === "authorization") return new ExternalCollectorError("permission", "Instagram denied Insights access (instagram_business_manage_insights required)");
  if (error.kind === "rate_limit") return new ExternalCollectorError("rate_limit", "Instagram rate limit");
  if (error.kind === "configuration") return new ExternalCollectorError("not_configured", "Instagram API version is not configured");
  if (error.kind === "provider" || error.kind === "timeout") return new ExternalCollectorError("temporary", "Instagram Insights temporary failure");
  return new ExternalCollectorError("request_rejected", `Instagram Insights request rejected (${error.kind})`);
}

/** Strict parse: lifetime period only, numeric value; absent metrics are simply not in the map. */
function parseInsights(body: Record<string, unknown>): Map<string, number> {
  if (!Array.isArray(body.data)) throw new ExternalCollectorError("malformed_payload", "Instagram Insights response has no data array");
  const values = new Map<string, number>();
  for (const entry of body.data as any[]) {
    const name = entry?.name, value = entry?.values?.[0]?.value;
    if (typeof name !== "string" || entry?.period !== "lifetime") throw new ExternalCollectorError("malformed_payload", "Instagram Insights entry is malformed");
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new ExternalCollectorError("malformed_payload", "Instagram Insights value is not numeric");
    values.set(name, value);
  }
  return values;
}

export class InstagramInsightsCollector implements ExternalAnalyticsCollector {
  readonly platform = "instagram";

  constructor(private readonly options: { media: readonly InstagramInsightsMedia[]; transport?: InstagramTransport; env?: NodeJS.ProcessEnv }) {}

  async collect(context: ExternalCollectorContext): Promise<ExternalCollectionResult> {
    let client: InstagramClient;
    try {
      client = new InstagramClient(context.accessToken, this.options.transport, this.options.env ?? process.env);
    } catch (error) {
      throw toCollectorError(error);
    }
    const metrics = INSTAGRAM_MEDIA_INSIGHT_METRICS.map((m) => m.provider);
    const observations: ExternalMetricObservation[] = [];
    const warnings = new Set<string>(this.options.media.length === 0 ? ["NO_PUBLISHED_INSTAGRAM_MEDIA"] : []);

    for (const { mediaId } of this.options.media) {
      let values: Map<string, number>;
      try {
        values = parseInsights(await client.getMediaInsights(mediaId, metrics));
      } catch (error) {
        if (error instanceof InstagramClientError && error.kind === "not_found") { warnings.add(`MEDIA_NOT_FOUND:${mediaId}`); continue; }
        if (!(error instanceof InstagramClientError && error.kind === "invalid_media")) throw toCollectorError(error);
        // Combined request rejected (e.g. a metric unsupported for this media type): one bounded retry per metric.
        values = new Map();
        for (const metric of metrics) {
          try {
            const single = parseInsights(await client.getMediaInsights(mediaId, [metric]));
            if (single.has(metric)) values.set(metric, single.get(metric)!);
          } catch (inner) {
            if (inner instanceof InstagramClientError && inner.kind === "invalid_media") { warnings.add(`METRIC_UNSUPPORTED:${metric}`); continue; }
            throw toCollectorError(inner);
          }
        }
      }
      for (const m of INSTAGRAM_MEDIA_INSIGHT_METRICS) {
        observations.push({ entityType: "media", externalEntityId: mediaId, metricKey: m.key, providerMetric: m.provider, value: values.get(m.provider) ?? null, unit: "count", windowSemantics: "cumulative_lifetime" });
      }
    }

    // Daily observation bucket for idempotency; the exact capture instant is the run's collected_at.
    return { platform: "instagram", sourceReference: "instagram.graph.media_insights:lifetime", observedAt: context.now.toISOString().slice(0, 10), window: null, observations, warnings: [...warnings].sort() };
  }
}
