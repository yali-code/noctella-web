import { z } from "zod";
import type { ProductProfitability, ProfitabilityPolicy, ProfitStatus } from "./productProfitability";
import type { AnalyticsInsight, AnalyticsThresholds, InsightCode, InsightSeverity } from "./profitabilityInsights";

/**
 * Phase 1E: known, documented policy gaps surfaced in every catalogue response. No payment-fee
 * NOT_APPLICABLE rule can be proven from current data (COD may carry courier fees), so a null
 * payment fee stays UNKNOWN.
 */
export const ANALYTICS_POLICY_GAPS = ["PAYMENT_FEE_POLICY_INCOMPLETE"] as const;

/**
 * Analytics Phase 1D: pure catalogue aggregation over already-evaluated Phase 1B projections and
 * Phase 1C insights. No financial math happens here - every amount, status and code is copied
 * from ProductProfitability / AnalyticsInsight; this module only selects, counts, filters and
 * sorts. Unknown amounts stay null and always sort last (never treated as zero).
 */

const PROFIT_STATUSES = ["COMPLETE", "PROVISIONAL", "INCOMPLETE", "NOT_SOLD"] as const;
const INSIGHT_CODES = ["COST_BASIS_MISSING", "COST_BASIS_CONFLICT", "SHIPPING_COST_MISSING", "REVENUE_CASH_MISMATCH", "NEGATIVE_PROFIT", "PROFITABILITY_INCOMPLETE", "LOW_MARGIN", "HIGH_MARGIN", "AGED_INVENTORY"] as const;
export const CATALOGUE_SORTS = ["severity_desc", "inventory_age_desc", "known_profit_asc", "known_profit_desc", "roi_asc", "roi_desc"] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

/** Input validation for the read API (route validates with this schema, then delegates). */
export const catalogueProfitabilityQuerySchema = z
  .object({
    productStatus: z.string().min(1).optional(),
    profitStatus: z.enum(PROFIT_STATUSES).optional(),
    saleState: z.enum(["sold", "not_sold"]).optional(),
    issueCode: z.string().min(1).optional(),
    insightCode: z.enum(INSIGHT_CODES).optional(),
    insightKey: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    sort: z.enum(CATALOGUE_SORTS).default("severity_desc"),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type CatalogueProfitabilityQuery = z.infer<typeof catalogueProfitabilityQuerySchema>;

export interface EvaluatedProduct {
  readonly profitability: ProductProfitability;
  readonly insights: readonly AnalyticsInsight[];
}

export interface CatalogueProfitabilityItem {
  readonly productId: string;
  readonly sku: string;
  readonly title: string;
  readonly category: string | null;
  readonly productStatus: string;
  readonly acquisitionDate: string;
  readonly inventoryAgeDays: number | null;
  readonly costBasisSource: ProductProfitability["cost"]["costBasisSource"];
  readonly authoritativeLandedCost: number | null;
  readonly saleState: "sold" | "not_sold";
  readonly saleAttemptCount: number;
  readonly profitStatus: ProfitStatus;
  /** Most recently completed sale attempt, copied unchanged (not aggregated across attempts). */
  readonly latestSale: {
    readonly orderId: string;
    readonly completedAt: string;
    readonly knownProfit: number | null;
    readonly profitBeforeUnknownCosts: number | null;
    readonly marginPercent: number | null;
    readonly roiPercent: number | null;
  } | null;
  readonly issueCodes: readonly string[];
  readonly conflictCodes: readonly string[];
  readonly policyFlags: readonly string[];
  readonly highestSeverity: InsightSeverity | null;
  readonly insights: readonly Pick<AnalyticsInsight, "key" | "code" | "severity" | "confidence" | "routingTarget" | "orderId">[];
}

export interface CatalogueProfitabilitySummary {
  readonly totalProducts: number;
  readonly sold: number;
  readonly notSold: number;
  readonly byProfitStatus: Readonly<Record<ProfitStatus, number>>;
  /** Number of products carrying at least one insight of each code. */
  readonly productsWithInsight: Readonly<Record<InsightCode, number>>;
}

export interface CatalogueProfitabilityResult {
  readonly summary: CatalogueProfitabilitySummary;
  readonly items: readonly CatalogueProfitabilityItem[];
  readonly meta: {
    readonly generatedAt: string;
    /** Items matching the filters, before pagination. The summary always covers the full catalogue. */
    readonly total: number;
    readonly returned: number;
    readonly limit: number;
    readonly offset: number;
    readonly sort: CatalogueSort;
    readonly filters: Readonly<Record<string, string>>;
    readonly policy: ProfitabilityPolicy;
    readonly provisionalPolicy: boolean;
    readonly thresholds: AnalyticsThresholds;
    readonly policyGaps: readonly (typeof ANALYTICS_POLICY_GAPS)[number][];
  };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 3, warning: 2, info: 1 };
const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort();

export function toCatalogueItem({ profitability: pp, insights }: EvaluatedProduct): CatalogueProfitabilityItem {
  const latest = pp.saleAttempts.length > 0 ? pp.saleAttempts[pp.saleAttempts.length - 1]! : null;
  const highest = insights.reduce<InsightSeverity | null>((top, i) => (top == null || SEVERITY_RANK[i.severity] > SEVERITY_RANK[top] ? i.severity : top), null);
  return {
    productId: pp.productId,
    sku: pp.sku,
    title: pp.title,
    category: pp.category,
    productStatus: pp.productStatus,
    acquisitionDate: pp.acquisitionDate,
    inventoryAgeDays: pp.inventoryAgeDays,
    costBasisSource: pp.cost.costBasisSource,
    authoritativeLandedCost: pp.cost.authoritativeLandedCost,
    saleState: pp.saleAttempts.length > 0 ? "sold" : "not_sold",
    saleAttemptCount: pp.saleAttempts.length,
    profitStatus: pp.profitStatus,
    latestSale: latest && {
      orderId: latest.orderId,
      completedAt: latest.completedAt,
      knownProfit: latest.knownProfit,
      profitBeforeUnknownCosts: latest.profitBeforeUnknownCosts,
      marginPercent: latest.marginPercent,
      roiPercent: latest.roiPercent,
    },
    issueCodes: uniqueSorted([...pp.cost.issueCodes, ...pp.saleAttempts.flatMap((s) => s.issueCodes)]),
    conflictCodes: uniqueSorted([...pp.cost.conflictCodes, ...pp.saleAttempts.flatMap((s) => s.conflictCodes)]),
    policyFlags: uniqueSorted(pp.saleAttempts.flatMap((s) => s.policyFlags)),
    highestSeverity: highest,
    insights: insights.map((i) => ({ key: i.key, code: i.code, severity: i.severity, confidence: i.confidence, routingTarget: i.routingTarget, ...(i.orderId ? { orderId: i.orderId } : {}) })),
  };
}

function summarize(items: readonly CatalogueProfitabilityItem[]): CatalogueProfitabilitySummary {
  const byProfitStatus = Object.fromEntries(PROFIT_STATUSES.map((s) => [s, 0])) as Record<ProfitStatus, number>;
  const productsWithInsight = Object.fromEntries(INSIGHT_CODES.map((c) => [c, 0])) as Record<InsightCode, number>;
  for (const item of items) {
    byProfitStatus[item.profitStatus] += 1;
    for (const code of new Set(item.insights.map((i) => i.code))) productsWithInsight[code] += 1;
  }
  const sold = items.filter((i) => i.saleState === "sold").length;
  return { totalProducts: items.length, sold, notSold: items.length - sold, byProfitStatus, productsWithInsight };
}

function matches(item: CatalogueProfitabilityItem, q: CatalogueProfitabilityQuery): boolean {
  if (q.productStatus && item.productStatus !== q.productStatus) return false;
  if (q.profitStatus && item.profitStatus !== q.profitStatus) return false;
  if (q.saleState && item.saleState !== q.saleState) return false;
  if (q.issueCode && !item.issueCodes.includes(q.issueCode) && !item.conflictCodes.includes(q.issueCode)) return false;
  if (q.insightCode && !item.insights.some((i) => i.code === q.insightCode)) return false;
  if (q.insightKey && !item.insights.some((i) => i.key === q.insightKey)) return false;
  if (q.category && item.category !== q.category) return false;
  return true;
}

/** Null-last numeric comparison in either direction - an unknown value never sorts as zero. */
function nullLast(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * direction;
}

function comparator(sort: CatalogueSort) {
  const primary = (a: CatalogueProfitabilityItem, b: CatalogueProfitabilityItem): number => {
    switch (sort) {
      case "inventory_age_desc": return nullLast(a.inventoryAgeDays, b.inventoryAgeDays, -1);
      case "known_profit_asc": return nullLast(a.latestSale?.knownProfit ?? null, b.latestSale?.knownProfit ?? null, 1);
      case "known_profit_desc": return nullLast(a.latestSale?.knownProfit ?? null, b.latestSale?.knownProfit ?? null, -1);
      case "roi_asc": return nullLast(a.latestSale?.roiPercent ?? null, b.latestSale?.roiPercent ?? null, 1);
      case "roi_desc": return nullLast(a.latestSale?.roiPercent ?? null, b.latestSale?.roiPercent ?? null, -1);
      case "severity_desc": return (b.highestSeverity ? SEVERITY_RANK[b.highestSeverity] : 0) - (a.highestSeverity ? SEVERITY_RANK[a.highestSeverity] : 0) || b.insights.length - a.insights.length;
    }
  };
  return (a: CatalogueProfitabilityItem, b: CatalogueProfitabilityItem) => primary(a, b) || a.sku.localeCompare(b.sku) || a.productId.localeCompare(b.productId);
}

export function buildCatalogueProfitability(
  evaluated: readonly EvaluatedProduct[],
  query: CatalogueProfitabilityQuery,
  generatedAt: Date,
  policy: ProfitabilityPolicy,
  thresholds: AnalyticsThresholds,
): CatalogueProfitabilityResult {
  const all = evaluated.map(toCatalogueItem);
  const filtered = all.filter((item) => matches(item, query)).sort(comparator(query.sort));
  const items = filtered.slice(query.offset, query.offset + query.limit);
  const { sort, limit, offset, ...filterFields } = query;
  const filters = Object.fromEntries(Object.entries(filterFields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  return {
    summary: summarize(all),
    items,
    meta: {
      generatedAt: generatedAt.toISOString(),
      total: filtered.length,
      returned: items.length,
      limit,
      offset,
      sort,
      filters,
      policy,
      provisionalPolicy: policy.inputVatPolicyProvisional || policy.revenuePolicyProvisional,
      thresholds,
      policyGaps: [...ANALYTICS_POLICY_GAPS],
    },
  };
}
