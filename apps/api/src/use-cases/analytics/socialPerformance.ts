import { z } from "zod";
import type { CatalogueProfitabilityItem } from "./catalogueProfitability";

/**
 * Analytics Stage 3: pure social performance read model over stored Instagram + Pinterest
 * snapshots, joined (read-only) to existing catalogue profitability facts for mapped products.
 * Each provider's metrics stay under their own keys/definitions - Instagram reach and Pinterest
 * impressions are never merged into a universal number. Product links are correlation only:
 * relation "RELATED" and a temporal "sale observed after publication" fact, never attribution.
 */

export const SOCIAL_PLATFORMS = ["instagram", "pinterest"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const socialPerformanceQuerySchema = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS).optional(),
    productId: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    contentType: z.string().min(1).optional(),
    mapped: z.enum(["true", "false"]).optional(),
    publishedFrom: z.string().datetime().optional(),
    publishedTo: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type SocialPerformanceQuery = z.infer<typeof socialPerformanceQuerySchema>;

export const socialHistoryQuerySchema = z
  .object({
    scopeId: z.string().regex(/^(instagram|pinterest):[A-Za-z0-9_-]+$/),
    metricKey: z.string().min(1).optional(),
    from: z.string().min(10).optional(),
    to: z.string().min(10).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
export type SocialHistoryQuery = z.infer<typeof socialHistoryQuerySchema>;

/** Stored snapshot row shape (analytics_metric_snapshots) as read by the service. */
export interface SocialSnapshotRow {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly metricNamespace: string;
  readonly metricKey: string;
  readonly numericValue: number | null;
  readonly valueState: string;
  readonly unit: string;
  readonly observedAt: string;
  readonly collectedAt: string;
  readonly metadataJson: string | null;
}

export interface SocialMetricObservation {
  readonly value: number | null;
  readonly valueState: string;
  readonly unit: string;
  readonly providerMetric: string | null;
  readonly windowSemantics: string | null;
  readonly observedAt: string;
  readonly collectedAt: string;
}

export interface SocialPerformanceItem {
  readonly platform: SocialPlatform;
  readonly scopeId: string;
  readonly entityType: "media" | "pin";
  readonly externalEntityId: string;
  readonly socialContentId: string | null;
  readonly contentType: string | null;
  readonly productId: string | null;
  readonly mappingStatus: "mapped" | "unmapped";
  readonly mappingBasis: string | null;
  readonly publishedAt: string | null;
  readonly latestObservedAt: string;
  readonly latestCollectedAt: string;
  /** Whole days from publication to the latest actual capture (collected_at); null if unknown. */
  readonly ageDaysAtLatestObservation: number | null;
  readonly observationCount: number;
  readonly latestMetrics: Readonly<Record<string, SocialMetricObservation>>;
  readonly metricCompleteness: { readonly known: number; readonly unknown: number };
  readonly product: {
    readonly sku: string;
    readonly title: string;
    readonly category: string | null;
    readonly productStatus: string;
    readonly saleState: "sold" | "not_sold";
    readonly profitStatus: string;
    readonly inventoryAgeDays: number | null;
    readonly latestSale: { readonly completedAt: string; readonly knownProfit: number | null; readonly marginPercent: number | null; readonly roiPercent: number | null } | null;
  } | null;
  readonly relation: "RELATED" | null;
  /** Temporal fact only (not attribution): the product's latest completed sale happened after publication. */
  readonly saleObservedAfterPublication: boolean | null;
}

const parseMeta = (json: string | null): Record<string, any> => {
  try { return json ? JSON.parse(json) : {}; } catch { return {}; }
};

export function buildSocialPerformance(
  rows: readonly SocialSnapshotRow[],
  productFacts: ReadonlyMap<string, CatalogueProfitabilityItem>,
  query: SocialPerformanceQuery,
): { summary: Record<string, unknown>; items: SocialPerformanceItem[]; meta: Record<string, unknown> } {
  const byScope = new Map<string, SocialSnapshotRow[]>();
  for (const row of rows) {
    if (!(SOCIAL_PLATFORMS as readonly string[]).includes(row.metricNamespace)) continue;
    byScope.set(row.scopeId, [...(byScope.get(row.scopeId) ?? []), row]);
  }

  const all: SocialPerformanceItem[] = [];
  for (const [scopeId, scopeRows] of byScope) {
    const ordered = [...scopeRows].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.collectedAt.localeCompare(b.collectedAt));
    const latestRow = ordered[ordered.length - 1]!;
    const meta = parseMeta(latestRow.metadataJson);
    const latestMetrics: Record<string, SocialMetricObservation> = {};
    for (const row of ordered) {
      const m = parseMeta(row.metadataJson);
      latestMetrics[row.metricKey] = { value: row.numericValue, valueState: row.valueState, unit: row.unit, providerMetric: m.providerMetric ?? null, windowSemantics: m.windowSemantics ?? null, observedAt: row.observedAt, collectedAt: row.collectedAt };
    }
    const values = Object.values(latestMetrics);
    const productId: string | null = typeof meta.productId === "string" ? meta.productId : null;
    const publishedAt: string | null = typeof meta.publishedAt === "string" ? meta.publishedAt : typeof meta.pinCreatedAt === "string" ? meta.pinCreatedAt : null;
    const latestCollectedAt = ordered.reduce((max, r) => (r.collectedAt > max ? r.collectedAt : max), ordered[0]!.collectedAt);
    const ageMs = publishedAt ? Date.parse(latestCollectedAt) - Date.parse(publishedAt) : Number.NaN;
    const fact = productId ? productFacts.get(productId) : undefined;
    const saleAt = fact?.latestSale?.completedAt ?? null;
    all.push({
      platform: latestRow.metricNamespace as SocialPlatform,
      scopeId,
      entityType: latestRow.scopeType === "external_pin" ? "pin" : "media",
      externalEntityId: String(meta.externalEntityId ?? scopeId.split(":").slice(1).join(":")),
      socialContentId: typeof meta.socialContentId === "string" ? meta.socialContentId : null,
      contentType: typeof meta.contentType === "string" ? meta.contentType : null,
      productId,
      mappingStatus: productId ? "mapped" : "unmapped",
      mappingBasis: typeof meta.mappingBasis === "string" ? meta.mappingBasis : null,
      publishedAt,
      latestObservedAt: latestRow.observedAt,
      latestCollectedAt,
      ageDaysAtLatestObservation: Number.isFinite(ageMs) && ageMs >= 0 ? Math.floor(ageMs / 86_400_000) : null,
      observationCount: new Set(ordered.map((r) => r.observedAt)).size,
      latestMetrics,
      metricCompleteness: { known: values.filter((v) => v.value !== null).length, unknown: values.filter((v) => v.value === null).length },
      product: fact
        ? {
            sku: fact.sku,
            title: fact.title,
            category: fact.category,
            productStatus: fact.productStatus,
            saleState: fact.saleState,
            profitStatus: fact.profitStatus,
            inventoryAgeDays: fact.inventoryAgeDays,
            latestSale: fact.latestSale ? { completedAt: fact.latestSale.completedAt, knownProfit: fact.latestSale.knownProfit, marginPercent: fact.latestSale.marginPercent, roiPercent: fact.latestSale.roiPercent } : null,
          }
        : null,
      relation: productId ? "RELATED" : null,
      saleObservedAfterPublication: saleAt && publishedAt ? saleAt > publishedAt : fact ? false : null,
    });
  }

  const filtered = all
    .filter((i) => !query.platform || i.platform === query.platform)
    .filter((i) => !query.productId || i.productId === query.productId)
    .filter((i) => !query.category || i.product?.category === query.category)
    .filter((i) => !query.contentType || i.contentType === query.contentType)
    .filter((i) => !query.mapped || (query.mapped === "true") === (i.mappingStatus === "mapped"))
    .filter((i) => !query.publishedFrom || (i.publishedAt !== null && i.publishedAt >= query.publishedFrom))
    .filter((i) => !query.publishedTo || (i.publishedAt !== null && i.publishedAt <= query.publishedTo))
    .sort((a, b) => b.latestCollectedAt.localeCompare(a.latestCollectedAt) || a.scopeId.localeCompare(b.scopeId));
  const items = filtered.slice(query.offset, query.offset + query.limit);
  const count = (p: SocialPlatform, mapped?: boolean) => all.filter((i) => i.platform === p && (mapped === undefined || (i.mappingStatus === "mapped") === mapped)).length;
  return {
    summary: Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, { entities: count(p), mapped: count(p, true), unmapped: count(p, false) }])),
    items,
    meta: { total: filtered.length, returned: items.length, limit: query.limit, offset: query.offset, correlationOnly: true, signals: "deferred: no owner-defined social thresholds" },
  };
}
