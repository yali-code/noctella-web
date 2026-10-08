import { z } from "zod";
import type { CatalogueProfitabilityResult } from "./catalogueProfitability";

/**
 * Analytics Phase 1G: pure mapping from the existing Phase 1B-1E catalogue result to point-in-time
 * snapshot metrics. No financial math - every value is copied from CatalogueProfitabilityResult.
 * Unknown values are stored as numericValue null with valueState "unknown" (never zero), and
 * values that cannot exist (e.g. inventory age with nothing in stock) as "not_applicable".
 */

/** Provenance for internal deterministic analytics; bump sourceReference if metric semantics change. */
export const PROFITABILITY_SNAPSHOT_SOURCE = Object.freeze({
  runType: "profitability_snapshot",
  sourceType: "internal_deterministic",
  sourceReference: "noctella.analytics.profitability.v1",
});

export type SnapshotScopeType = "catalogue" | "product";
export type SnapshotValueState = "known" | "unknown" | "not_applicable";
export type SnapshotUnit = "eur" | "percent" | "days" | "count" | "status";

export interface SnapshotMetric {
  readonly scopeType: SnapshotScopeType;
  readonly scopeId: string;
  readonly metricNamespace: "profitability" | "insight";
  readonly metricKey: string;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly valueState: SnapshotValueState;
  readonly unit: SnapshotUnit;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

/** Daily observation bucket: UTC midnight of `now`. One internal snapshot per day is sufficient. */
export function observationDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const CATALOGUE_SCOPE_ID = "catalogue";
const amount = (value: number | null, unit: SnapshotUnit, unknownState: SnapshotValueState = "unknown") =>
  ({ numericValue: value, textValue: null, valueState: value == null ? unknownState : ("known" as SnapshotValueState), unit });

export function buildProfitabilitySnapshotMetrics(result: CatalogueProfitabilityResult): SnapshotMetric[] {
  const metrics: SnapshotMetric[] = [];
  const catalogue = (metricNamespace: SnapshotMetric["metricNamespace"], metricKey: string, value: number) =>
    metrics.push({ scopeType: "catalogue", scopeId: CATALOGUE_SCOPE_ID, metricNamespace, metricKey, ...amount(value, "count"), metadata: null });

  const { summary } = result;
  catalogue("profitability", "product_count", summary.totalProducts);
  catalogue("profitability", "sold_count", summary.sold);
  catalogue("profitability", "unsold_count", summary.notSold);
  for (const [status, count] of Object.entries(summary.byProfitStatus)) catalogue("profitability", `status_${status.toLowerCase()}_count`, count);
  for (const [code, count] of Object.entries(summary.productsWithInsight)) catalogue("insight", `products_with_${code.toLowerCase()}`, count);

  for (const item of [...result.items].sort((a, b) => a.productId.localeCompare(b.productId))) {
    const product = (metricNamespace: SnapshotMetric["metricNamespace"], metricKey: string, value: Omit<SnapshotMetric, "scopeType" | "scopeId" | "metricNamespace" | "metricKey">) =>
      metrics.push({ scopeType: "product", scopeId: item.productId, metricNamespace, metricKey, ...value });

    product("profitability", "inventory_age_days", { ...amount(item.inventoryAgeDays, "days", "not_applicable"), metadata: { acquisitionDate: item.acquisitionDate } });
    product("profitability", "authoritative_landed_cost", { ...amount(item.authoritativeLandedCost, "eur"), metadata: { costBasisSource: item.costBasisSource } });
    product("profitability", "profit_status", { numericValue: null, textValue: item.profitStatus, valueState: "known", unit: "status", metadata: null });
    if (item.latestSale) {
      const saleMeta = { orderId: item.latestSale.orderId, completedAt: item.latestSale.completedAt };
      product("profitability", "known_profit", { ...amount(item.latestSale.knownProfit, "eur"), metadata: saleMeta });
      product("profitability", "margin_percent", { ...amount(item.latestSale.marginPercent, "percent"), metadata: saleMeta });
      product("profitability", "roi_percent", { ...amount(item.latestSale.roiPercent, "percent"), metadata: saleMeta });
    }
    const byCode = new Map<string, string[]>();
    for (const insight of item.insights) byCode.set(insight.code, [...(byCode.get(insight.code) ?? []), insight.key]);
    for (const [code, keys] of [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      product("insight", code.toLowerCase(), { ...amount(keys.length, "count"), metadata: { keys } });
    }
  }
  return metrics;
}

/** Read-API validation for one product's metric history. */
export const productMetricHistoryQuerySchema = z
  .object({
    metricKey: z.string().min(1).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
export type ProductMetricHistoryQuery = z.infer<typeof productMetricHistoryQuerySchema>;
