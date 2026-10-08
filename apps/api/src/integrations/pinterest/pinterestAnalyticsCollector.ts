import { ExternalCollectorError, type ExternalAnalyticsCollector, type ExternalCollectionResult, type ExternalCollectorContext, type ExternalMetricObservation } from "../../use-cases/analytics/externalMetrics";

/**
 * Analytics Stage 3: Pinterest organic Pin analytics collector (API v5). Pins are discovered with
 * GET /v5/pins (bookmark pagination, bounded) and measured with the multi-Pin endpoint
 * GET /v5/pins/analytics (up to 100 pin_ids per request, start_date/end_date in UTC YYYY-MM-DD).
 * Metrics are Pinterest's own definitions, stored per metric as provided (summary over the
 * requested range) - no Noctella re-definition, no derived rates. A metric Pinterest does not
 * return for a Pin stays unknown (null), never zero.
 */

export const PINTEREST_PIN_METRICS: readonly { readonly provider: string; readonly key: string }[] = Object.freeze([
  { provider: "IMPRESSION", key: "pin_impressions" },
  { provider: "SAVE", key: "pin_saves" },
  { provider: "PIN_CLICK", key: "pin_clicks" },
  { provider: "OUTBOUND_CLICK", key: "pin_outbound_clicks" },
]);
export const PINTEREST_ANALYTICS_BATCH = 100;
export const PINTEREST_MAX_PIN_PAGES = 10;

export interface DiscoveredPin { readonly id: string; readonly link: string | null; readonly createdAt: string | null }

/** Fixed one-day window two days before `now` (UTC), so the day is complete. */
export function pinterestReportDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2)).toISOString().slice(0, 10);
}

function errorFor(status: number): ExternalCollectorError {
  if (status === 401) return new ExternalCollectorError("authentication", "Pinterest rejected the access token");
  if (status === 403) return new ExternalCollectorError("permission", "Pinterest denied access (analytics scope or app access missing)");
  if (status === 429) return new ExternalCollectorError("rate_limit", "Pinterest rate limit");
  if (status >= 500) return new ExternalCollectorError("temporary", `Pinterest temporary failure (${status})`);
  return new ExternalCollectorError("request_rejected", `Pinterest rejected the request (${status})`);
}

export class PinterestAnalyticsCollector implements ExternalAnalyticsCollector {
  readonly platform = "pinterest";
  /** Pins discovered in the last collect() call - lets the caller map Pins to products by link. */
  discoveredPins: DiscoveredPin[] = [];

  constructor(private readonly options: { fetchImpl?: typeof fetch; apiBaseUrl?: string; onPinsDiscovered?: (pins: readonly DiscoveredPin[]) => void }) {}

  private async getJson(url: string, accessToken: string): Promise<any> {
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    } catch {
      throw new ExternalCollectorError("temporary", "Pinterest request failed");
    }
    if (!response.ok) throw errorFor(response.status);
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") throw new ExternalCollectorError("malformed_payload", "Pinterest response is not JSON");
    return body;
  }

  async collect(context: ExternalCollectorContext): Promise<ExternalCollectionResult> {
    const base = this.options.apiBaseUrl ?? "https://api.pinterest.com";
    const warnings = new Set<string>();
    const pins: DiscoveredPin[] = [];
    let bookmark: string | null = null;
    for (let page = 0; page < PINTEREST_MAX_PIN_PAGES; page += 1) {
      const url = new URL("/v5/pins", base);
      url.searchParams.set("page_size", "100");
      if (bookmark) url.searchParams.set("bookmark", bookmark);
      const body = await this.getJson(url.toString(), context.accessToken);
      if (!Array.isArray(body.items)) throw new ExternalCollectorError("malformed_payload", "Pinterest pin list is malformed");
      for (const item of body.items) {
        if (typeof item?.id !== "string") throw new ExternalCollectorError("malformed_payload", "Pinterest pin is malformed");
        pins.push({ id: item.id, link: typeof item.link === "string" ? item.link : null, createdAt: typeof item.created_at === "string" ? item.created_at : null });
      }
      bookmark = typeof body.bookmark === "string" && body.bookmark ? body.bookmark : null;
      if (!bookmark) break;
      if (page === PINTEREST_MAX_PIN_PAGES - 1) warnings.add("PIN_DISCOVERY_TRUNCATED");
    }
    this.discoveredPins = pins;
    this.options.onPinsDiscovered?.(pins);
    if (pins.length === 0) warnings.add("NO_PINTEREST_PINS");

    const day = pinterestReportDay(context.now);
    const observations: ExternalMetricObservation[] = [];
    const ids = [...new Set(pins.map((p) => p.id))].sort();
    for (let i = 0; i < ids.length; i += PINTEREST_ANALYTICS_BATCH) {
      const batch = ids.slice(i, i + PINTEREST_ANALYTICS_BATCH);
      const url = new URL("/v5/pins/analytics", base);
      url.searchParams.set("pin_ids", batch.join(","));
      url.searchParams.set("start_date", day);
      url.searchParams.set("end_date", day);
      url.searchParams.set("metric_types", PINTEREST_PIN_METRICS.map((m) => m.provider).join(","));
      const body = await this.getJson(url.toString(), context.accessToken);
      for (const pinId of batch) {
        const perApp = body[pinId];
        // Response: { <pinId>: { <app type, default "all">: { summary_metrics: { METRIC: number } } } }
        const summary = perApp && typeof perApp === "object" ? (perApp.all ?? (Object.keys(perApp).length === 1 ? Object.values(perApp)[0] : undefined))?.summary_metrics : undefined;
        if (perApp !== undefined && summary !== undefined && (typeof summary !== "object" || summary === null)) throw new ExternalCollectorError("malformed_payload", "Pinterest analytics summary is malformed");
        if (!summary) warnings.add(`MISSING_PIN_ANALYTICS:${pinId}`);
        for (const m of PINTEREST_PIN_METRICS) {
          const raw = summary?.[m.provider];
          if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isFinite(raw))) throw new ExternalCollectorError("malformed_payload", "Pinterest metric value is not numeric");
          observations.push({ entityType: "pin", externalEntityId: pinId, metricKey: m.key, providerMetric: m.provider, value: typeof raw === "number" ? raw : null, unit: "count", windowSemantics: "fixed_range" });
        }
      }
    }
    return { platform: "pinterest", sourceReference: "pinterest.v5.pins_analytics:summary", observedAt: day, window: { start: day, end: day }, observations, warnings: [...warnings].sort() };
  }
}
