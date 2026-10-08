import { ExternalCollectorError, type ExternalAnalyticsCollector, type ExternalCollectionResult, type ExternalCollectorContext, type ExternalMetricObservation, type ExternalMetricUnit } from "../../use-cases/analytics/externalMetrics";

/**
 * Stage 3B: eBay Sell Analytics traffic report collector (GET /sell/analytics/v1/traffic_report,
 * scope sell.analytics.readonly). Uses only documented identifiers: dimension LISTING and the
 * metrics below; filter marketplace_ids:{..},date_range:[YYYYMMDD..YYYYMMDD],listing_ids:{a|b}.
 * Listings are requested in bounded batches (one request per batch, not per listing). Provider
 * values are stored as given - rates are never rescaled or derived, and a value eBay marks
 * not applicable or omits stays unknown (null), never zero.
 */

export const EBAY_TRAFFIC_REPORT_METRICS: readonly { readonly provider: string; readonly key: string; readonly unit: ExternalMetricUnit }[] = Object.freeze([
  { provider: "LISTING_IMPRESSION_TOTAL", key: "listing_impressions", unit: "count" },
  { provider: "LISTING_VIEWS_TOTAL", key: "listing_views", unit: "count" },
  // eBay supplies its own CTR/conversion values; the docs do not state their scale -> provider_defined.
  { provider: "CLICK_THROUGH_RATE", key: "click_through_rate", unit: "provider_defined" },
  { provider: "SALES_CONVERSION_RATE", key: "conversion_rate", unit: "provider_defined" },
  { provider: "TRANSACTION", key: "transactions", unit: "count" },
]);

/** Bounded listing batch per request (keeps each request small; avoids one call per listing). */
export const EBAY_TRAFFIC_LISTING_BATCH = 200;

/**
 * Deterministic fixed one-day window: the calendar date two days before `now` (UTC date). Two
 * days back guarantees a fully completed day regardless of which timezone eBay applies to the
 * date range; the provider's own date strings are stored (no timezone is asserted).
 */
export function ebayTrafficReportDay(now: Date): { isoDate: string; compact: string } {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2));
  const isoDate = day.toISOString().slice(0, 10);
  return { isoDate, compact: isoDate.replace(/-/g, "") };
}

function errorFor(status: number): ExternalCollectorError {
  if (status === 401) return new ExternalCollectorError("authentication", "eBay rejected the access token");
  if (status === 403) return new ExternalCollectorError("permission", "eBay denied Analytics access (sell.analytics.readonly consent required)");
  if (status === 429) return new ExternalCollectorError("rate_limit", "eBay Analytics rate limit");
  if (status >= 500) return new ExternalCollectorError("temporary", `eBay Analytics temporary failure (${status})`);
  return new ExternalCollectorError("request_rejected", `eBay Analytics rejected the request (${status})`);
}

function metricValue(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") throw new ExternalCollectorError("malformed_payload", "eBay traffic report metric value is malformed");
  const { value, applicable } = raw as { value?: unknown; applicable?: unknown };
  if (applicable === false || value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new ExternalCollectorError("malformed_payload", "eBay traffic report metric value is not numeric");
  return n;
}

export class EbayAnalyticsCollector implements ExternalAnalyticsCollector {
  readonly platform = "ebay";

  constructor(private readonly options: { apiBaseUrl: string; marketplaceId: string; listingIds: readonly string[]; fetchImpl?: typeof fetch }) {}

  async collect(context: ExternalCollectorContext): Promise<ExternalCollectionResult> {
    const { apiBaseUrl, marketplaceId, fetchImpl = fetch } = this.options;
    const day = ebayTrafficReportDay(context.now);
    const listingIds = [...new Set(this.options.listingIds)].sort();
    const observations: ExternalMetricObservation[] = [];
    const warnings: string[] = listingIds.length === 0 ? ["NO_EBAY_LISTINGS"] : [];

    for (let i = 0; i < listingIds.length; i += EBAY_TRAFFIC_LISTING_BATCH) {
      const batch = listingIds.slice(i, i + EBAY_TRAFFIC_LISTING_BATCH);
      const url = new URL("/sell/analytics/v1/traffic_report", apiBaseUrl);
      url.searchParams.set("dimension", "LISTING");
      url.searchParams.set("filter", `marketplace_ids:{${marketplaceId}},date_range:[${day.compact}..${day.compact}],listing_ids:{${batch.join("|")}}`);
      url.searchParams.set("metric", EBAY_TRAFFIC_REPORT_METRICS.map((m) => m.provider).join(","));

      let response: Response;
      try {
        response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${context.accessToken}`, Accept: "application/json" } });
      } catch {
        throw new ExternalCollectorError("temporary", "eBay Analytics request failed");
      }
      if (!response.ok) throw errorFor(response.status);
      const body = (await response.json().catch(() => null)) as any;
      const dimensionKey = body?.header?.dimensionKeys?.[0]?.key;
      const headerMetrics: unknown = body?.header?.metrics;
      if (dimensionKey !== "LISTING_ID" || !Array.isArray(headerMetrics) || !Array.isArray(body?.records)) {
        throw new ExternalCollectorError("malformed_payload", "eBay traffic report response shape is not recognised");
      }
      const metricIndex = new Map<string, number>(headerMetrics.map((m: any, index: number) => [String(m?.key), index]));
      for (const m of EBAY_TRAFFIC_REPORT_METRICS) if (!metricIndex.has(m.provider)) warnings.push(`METRIC_NOT_RETURNED:${m.provider}`);

      const byListing = new Map<string, unknown[]>();
      for (const record of body.records as any[]) {
        const listingId = record?.dimensionValues?.[0]?.value;
        if (typeof listingId !== "string" || !Array.isArray(record?.metricValues)) throw new ExternalCollectorError("malformed_payload", "eBay traffic report record is malformed");
        if (byListing.has(listingId)) throw new ExternalCollectorError("malformed_payload", "eBay traffic report repeated a listing");
        byListing.set(listingId, record.metricValues);
      }
      for (const listingId of batch) {
        const values = byListing.get(listingId);
        if (!values) warnings.push(`MISSING_TRAFFIC_RECORD:${listingId}`);
        for (const m of EBAY_TRAFFIC_REPORT_METRICS) {
          const index = metricIndex.get(m.provider);
          observations.push({
            entityType: "listing",
            externalEntityId: listingId,
            metricKey: m.key,
            providerMetric: m.provider,
            value: values && index !== undefined && index < values.length ? metricValue(values[index]) : null,
            unit: m.unit,
            windowSemantics: "fixed_range",
          });
        }
      }
    }

    return {
      platform: "ebay",
      sourceReference: `ebay.sell.analytics.v1.traffic_report:LISTING:${marketplaceId}`,
      observedAt: day.isoDate,
      window: { start: day.isoDate, end: day.isoDate },
      observations,
      warnings: [...new Set(warnings)],
    };
  }
}
