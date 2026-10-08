import type { ProductProfitability, SaleAttemptProfitability } from "./productProfitability";

/**
 * Analytics Phase 1C: pure, deterministic profitability insight projection - no I/O, no clock
 * access (callers pass `evaluatedAt`), no database access, no LLM, no persistence. Consumes the
 * Phase 1B ProductProfitability projection as the sole source of profitability truth and never
 * recalculates revenue, VAT, cost, refunds, fees, shipping or FX - every evidence value is copied
 * from the projection unchanged (unknown stays null, never 0).
 *
 * Insights are ADVISORY ONLY: they describe what the data shows and name the department that
 * should review it. They never change prices, products, inventory, listings, promotions,
 * accounting records or content, and nothing here calls an operational writer.
 */

export type InsightCode =
  | "COST_BASIS_MISSING"
  | "COST_BASIS_CONFLICT"
  | "SHIPPING_COST_MISSING"
  | "REVENUE_CASH_MISMATCH"
  | "NEGATIVE_PROFIT"
  | "PROFITABILITY_INCOMPLETE"
  | "LOW_MARGIN"
  | "HIGH_MARGIN"
  | "AGED_INVENTORY";

/**
 * Phase 1E: owner-configurable ANALYTICS POLICY thresholds (not accounting rules). Injectable so
 * tests and a later persisted owner setting can replace the code defaults without touching the
 * signal rules.
 */
export interface AnalyticsThresholds {
  /** LOW_MARGIN fires for a final margin in [0, lowMarginPercent). Negative margins are NEGATIVE_PROFIT. */
  readonly lowMarginPercent: number;
  /** HIGH_MARGIN fires for a final margin >= highMarginPercent. */
  readonly highMarginPercent: number;
  /** AGED_INVENTORY fires for in-stock products whose purchase-recorded inventory age >= this. */
  readonly agedInventoryDays: number;
}

export const DEFAULT_ANALYTICS_THRESHOLDS: AnalyticsThresholds = Object.freeze({ lowMarginPercent: 20, highMarginPercent: 40, agedInventoryDays: 90 });
export type InsightEntityType = "product" | "sale_attempt";
export type InsightSeverity = "info" | "warning" | "critical";
/** Categorical and derived from data quality only - never a percentage. */
export type InsightConfidence = "HIGH" | "MEDIUM" | "LOW";
/** Routing metadata only - no queue, event or outbox delivery exists in Phase 1C. */
export type InsightRoutingTarget = "FINANCE" | "PRICING" | "OPERATIONS" | "INVENTORY" | "SOURCING" | "SALES" | "MEDIA";

export interface InsightEvidence {
  /** Canonical ProductProfitability path the value was copied from. */
  readonly fact: string;
  readonly value: number | string | boolean | null;
}

export interface AnalyticsInsight {
  /** Deterministic: code:entityType:entityId[:orderId] - identical for the same condition across calls. */
  readonly key: string;
  readonly code: InsightCode;
  readonly entityType: InsightEntityType;
  readonly entityId: string;
  readonly orderId?: string;
  readonly severity: InsightSeverity;
  readonly title: string;
  readonly recommendation: string;
  readonly evidence: readonly InsightEvidence[];
  readonly confidence: InsightConfidence;
  /** Copied from the underlying ProductProfitability row - never recomputed here. */
  readonly dataCompleteness: ProductProfitability["profitStatus"];
  readonly routingTarget: InsightRoutingTarget;
  readonly advisoryOnly: true;
  readonly evaluatedAt: string;
}

const NEGATIVE_PROFIT_SUPPRESSING_ISSUES = new Set(["RETURN_PENDING", "REVERSAL_COST_RECOVERY_INCOMPLETE", "FX_ANALYTICS_GAP"]);

function codeEvidence(prefix: string, attempt: SaleAttemptProfitability): InsightEvidence[] {
  return [
    ...attempt.issueCodes.map((code) => ({ fact: `${prefix}.issueCode`, value: code })),
    ...attempt.conflictCodes.map((code) => ({ fact: `${prefix}.conflictCode`, value: code })),
    ...attempt.policyFlags.map((flag) => ({ fact: `${prefix}.policyFlag`, value: flag })),
  ];
}

/**
 * Financial-outcome confidence: LOW when a conflict or an ambiguous allocation undermines the
 * inputs; MEDIUM when only provisional policies (or a partial upper-bound figure) limit
 * certainty; HIGH only for a fully known, conflict-free, non-provisional result - unreachable
 * while the Phase 1B OD-2/OD-9 policies remain provisional, by design.
 */
function financialConfidence(attempt: SaleAttemptProfitability): InsightConfidence {
  if (attempt.conflictCodes.length > 0 || attempt.issueCodes.includes("ALLOCATION_AMBIGUOUS")) return "LOW";
  if (attempt.policyFlags.length > 0 || attempt.knownProfit == null) return "MEDIUM";
  return "HIGH";
}

export function deriveProfitabilityInsights(
  profitability: ProductProfitability,
  evaluatedAt: Date,
  thresholds: AnalyticsThresholds = DEFAULT_ANALYTICS_THRESHOLDS,
): AnalyticsInsight[] {
  const at = evaluatedAt.toISOString();
  const productId = profitability.productId;
  const insights: AnalyticsInsight[] = [];
  const base = { dataCompleteness: profitability.profitStatus, advisoryOnly: true as const, evaluatedAt: at };
  const productInsight = (code: InsightCode, rest: Omit<AnalyticsInsight, "key" | "code" | "entityType" | "entityId" | "dataCompleteness" | "advisoryOnly" | "evaluatedAt">) =>
    insights.push({ key: `${code}:product:${productId}`, code, entityType: "product", entityId: productId, ...base, ...rest });
  const attemptInsight = (code: InsightCode, orderId: string, rest: Omit<AnalyticsInsight, "key" | "code" | "entityType" | "entityId" | "orderId" | "dataCompleteness" | "advisoryOnly" | "evaluatedAt">) =>
    insights.push({ key: `${code}:sale_attempt:${productId}:${orderId}`, code, entityType: "sale_attempt", entityId: productId, orderId, ...base, ...rest });

  const { cost } = profitability;
  const costCodeEvidence = [
    ...cost.issueCodes.map((code) => ({ fact: "cost.issueCode", value: code })),
    ...cost.conflictCodes.map((code) => ({ fact: "cost.conflictCode", value: code })),
  ];

  if (cost.costBasisSource === "missing") {
    productInsight("COST_BASIS_MISSING", {
      severity: "warning",
      title: "Acquisition cost is missing",
      recommendation: "Review the missing acquisition cost and enter or verify it before relying on profitability.",
      evidence: [
        { fact: "cost.costBasisSource", value: cost.costBasisSource },
        { fact: "cost.authoritativeLandedCost", value: cost.authoritativeLandedCost },
        { fact: "cost.productPurchaseCost", value: cost.productPurchaseCost },
        { fact: "cost.allocationDerivedLandedCost", value: cost.allocationDerivedLandedCost },
        ...costCodeEvidence,
      ],
      confidence: "HIGH",
      routingTarget: "FINANCE",
    });
  }

  if (cost.conflictCodes.includes("COST_BASIS_CONFLICT")) {
    productInsight("COST_BASIS_CONFLICT", {
      severity: "warning",
      title: "Acquisition cost records conflict",
      recommendation: "Verify the conflicting acquisition-cost records; the purchase allocation is currently used as the cost basis.",
      evidence: [
        { fact: "cost.allocationDerivedLandedCost", value: cost.allocationDerivedLandedCost },
        { fact: "cost.productPurchaseCost", value: cost.productPurchaseCost },
        { fact: "cost.authoritativeLandedCost", value: cost.authoritativeLandedCost },
        { fact: "cost.costBasisSource", value: cost.costBasisSource },
        ...costCodeEvidence,
      ],
      confidence: "HIGH",
      routingTarget: "FINANCE",
    });
  }

  // One product-level insight, never one per missing fee or blocking code: the codes (including
  // the systemic UNKNOWN_PAYMENT_FEE) appear only as evidence.
  if (profitability.profitStatus === "INCOMPLETE") {
    productInsight("PROFITABILITY_INCOMPLETE", {
      severity: "info",
      title: "Profitability is incomplete",
      recommendation: "Complete or verify the missing financial inputs before relying on final profitability, margin or ROI.",
      evidence: [
        { fact: "profitStatus", value: profitability.profitStatus },
        ...profitability.saleAttempts
          .filter((attempt) => attempt.profitStatus === "INCOMPLETE")
          .flatMap((attempt) => codeEvidence(`saleAttempts[${attempt.orderId}]`, attempt)),
      ],
      confidence: "HIGH",
      routingTarget: "FINANCE",
    });
  }

  // Current inventory only (inventoryAgeDays is null when nothing is in stock) and only with a
  // purchase-recorded acquisition date - the product_created fallback is not an acquisition date.
  if (profitability.inventoryAgeDays != null && profitability.acquisitionDateSource !== "product_created" && profitability.inventoryAgeDays >= thresholds.agedInventoryDays) {
    productInsight("AGED_INVENTORY", {
      severity: "warning",
      title: "Inventory age exceeds the configured threshold",
      recommendation: "Review this in-stock item; it has exceeded the configured inventory-age threshold.",
      evidence: [
        { fact: "inventoryAgeDays", value: profitability.inventoryAgeDays },
        { fact: "acquisitionDate", value: profitability.acquisitionDate },
        { fact: "acquisitionDateSource", value: profitability.acquisitionDateSource },
        { fact: "threshold.agedInventoryDays", value: thresholds.agedInventoryDays },
      ],
      confidence: "HIGH",
      routingTarget: "INVENTORY",
    });
  }

  for (const attempt of profitability.saleAttempts) {
    const prefix = `saleAttempts[${attempt.orderId}]`;

    // marginPercent is only non-null when knownProfit is (every applicable component known, no
    // blocking issue, item scope) - a partial/incomplete profit can never trigger these.
    const margin = attempt.marginPercent;
    const marginEvidence = (threshold: string, value: number): InsightEvidence[] => [
      { fact: `${prefix}.marginPercent`, value: margin },
      { fact: `${prefix}.knownProfit`, value: attempt.knownProfit },
      { fact: `${prefix}.grossRevenue`, value: attempt.grossRevenue },
      { fact: `${prefix}.costCharged`, value: attempt.costCharged },
      { fact: `threshold.${threshold}`, value },
      ...codeEvidence(prefix, attempt),
    ];
    if (margin != null && margin >= 0 && margin < thresholds.lowMarginPercent) {
      attemptInsight("LOW_MARGIN", attempt.orderId, {
        severity: "warning",
        title: "Margin is below the configured threshold",
        recommendation: "Review the pricing and acquisition cost of this sale; its margin is below the configured threshold.",
        evidence: marginEvidence("lowMarginPercent", thresholds.lowMarginPercent),
        confidence: financialConfidence(attempt),
        routingTarget: "PRICING",
      });
    }
    if (margin != null && margin >= thresholds.highMarginPercent) {
      attemptInsight("HIGH_MARGIN", attempt.orderId, {
        severity: "info",
        title: "Margin is at or above the configured threshold",
        recommendation: "Review this sale as a possible sourcing reference; its margin meets the configured high-margin threshold.",
        evidence: marginEvidence("highMarginPercent", thresholds.highMarginPercent),
        confidence: financialConfidence(attempt),
        routingTarget: "SOURCING",
      });
    }

    if (attempt.issueCodes.includes("MISSING_OUTBOUND_SHIPPING")) {
      attemptInsight("SHIPPING_COST_MISSING", attempt.orderId, {
        severity: "warning",
        title: "Outbound shipping cost is missing",
        recommendation: "Record or verify the actual outbound shipping cost for this sale; a zero is not assumed to mean free shipping.",
        evidence: [
          { fact: `${prefix}.orderId`, value: attempt.orderId },
          { fact: `${prefix}.outboundShippingCost`, value: attempt.outboundShippingCost },
          { fact: `${prefix}.issueCode`, value: "MISSING_OUTBOUND_SHIPPING" },
          ...attempt.issueCodes.filter((code) => code === "SHIPPING_COST_ZERO_AMBIGUOUS").map((code) => ({ fact: `${prefix}.issueCode`, value: code })),
        ],
        confidence: "MEDIUM",
        routingTarget: "OPERATIONS",
      });
    }

    if (attempt.conflictCodes.includes("REVENUE_CASH_MISMATCH")) {
      attemptInsight("REVENUE_CASH_MISMATCH", attempt.orderId, {
        severity: "warning",
        title: "Recorded revenue differs from cash collected",
        recommendation: "Review the recorded revenue and the cash collection data for this sale.",
        evidence: [
          { fact: `${prefix}.grossRevenue`, value: attempt.grossRevenue },
          { fact: `${prefix}.cashCollected`, value: attempt.cashCollected },
          { fact: `${prefix}.grossVsCashDifference`, value: attempt.grossVsCashDifference },
          { fact: `${prefix}.conflictCode`, value: "REVENUE_CASH_MISMATCH" },
          ...attempt.policyFlags.filter((flag) => flag === "REVENUE_POLICY_PROVISIONAL").map((flag) => ({ fact: `${prefix}.policyFlag`, value: flag })),
        ],
        confidence: "MEDIUM",
        routingTarget: "FINANCE",
      });
    }

    // profitBeforeUnknownCosts excludes only non-negative unknown costs (fees, outbound shipping),
    // so under the current Phase 1B policy it is an upper bound on final profit. Suppressed where
    // that bound is not safe: a pending return or incomplete reversal recovery can lower the cost
    // charged, an FX gap is unconverted, and an order-level scope is not attributable.
    const loss = (attempt.knownProfit != null && attempt.knownProfit < 0) || (attempt.profitBeforeUnknownCosts != null && attempt.profitBeforeUnknownCosts < 0);
    const suppressed = attempt.amountScope === "order" || attempt.issueCodes.some((code) => NEGATIVE_PROFIT_SUPPRESSING_ISSUES.has(code));
    if (loss && !suppressed) {
      attemptInsight("NEGATIVE_PROFIT", attempt.orderId, {
        severity: "critical",
        title: "Available profitability data indicates a loss",
        recommendation: "Review this sale's economics; consider pricing changes only after the underlying profitability data is sufficiently complete.",
        evidence: [
          { fact: `${prefix}.knownProfit`, value: attempt.knownProfit },
          { fact: `${prefix}.profitBeforeUnknownCosts`, value: attempt.profitBeforeUnknownCosts },
          { fact: "cost.authoritativeLandedCost", value: cost.authoritativeLandedCost },
          { fact: `${prefix}.costCharged`, value: attempt.costCharged },
          { fact: `${prefix}.knownNetRevenue`, value: attempt.knownNetRevenue },
          { fact: `${prefix}.grossRevenue`, value: attempt.grossRevenue },
          { fact: `${prefix}.outboundShippingCost`, value: attempt.outboundShippingCost },
          { fact: `${prefix}.marketplaceFee.status`, value: attempt.marketplaceFee.status },
          { fact: `${prefix}.promotedFee.status`, value: attempt.promotedFee.status },
          { fact: `${prefix}.paymentFee.status`, value: attempt.paymentFee.status },
          { fact: `${prefix}.fullReversal`, value: attempt.fullReversal },
          ...codeEvidence(prefix, attempt),
        ],
        confidence: financialConfidence(attempt),
        routingTarget: "PRICING",
      });
    }
  }

  return insights;
}
