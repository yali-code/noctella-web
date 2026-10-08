/**
 * Analytics Phase 1B: pure, deterministic product profitability projection - no I/O, no clock
 * access (callers pass `now`), no database access, no LLM. Every input is resolved by
 * services/productProfitability.ts from existing canonical tables (read-only); this module only
 * derives values at query time and never persists anything, so it never becomes a second
 * financial source of truth. The original sale_financials row is surfaced unchanged as
 * `recorded`; the analytical figures here may intentionally differ from legacy ERP reports
 * (owner decision OD-6: full reversals are not zeroed).
 *
 * Permanent rule: UNKNOWN != ZERO. A missing amount stays null and raises an issue code; it is
 * never silently treated as 0.
 */

/**
 * Owner decisions OD-2 (input VAT) and OD-9 (revenue authority) are PROVISIONAL accounting
 * policies. Kept as an explicit, injectable policy object (never hard-coded into the formula) so
 * a later phase can switch to ex-input-VAT profitability once the owner/accountant confirms
 * recoverability. Neither flag infers any VAT or margin-scheme rule.
 */
export interface ProfitabilityPolicy {
  /** OD-2: whether allocated purchase VAT counts as part of landed cost. */
  readonly inputVatInLandedCost: "include" | "exclude";
  readonly inputVatPolicyProvisional: boolean;
  /** OD-9: gross revenue is sale_financials.grossRevenue (the issued invoice total). */
  readonly revenuePolicyProvisional: boolean;
}

export const PROVISIONAL_PROFITABILITY_POLICY: ProfitabilityPolicy = Object.freeze({
  inputVatInLandedCost: "include",
  inputVatPolicyProvisional: true,
  revenuePolicyProvisional: true,
});

export const BLOCKING_ISSUE_CODES = [
  "MISSING_COST_BASIS",
  "ALLOCATION_COMPONENTS_INCOMPLETE",
  "MISSING_OUTBOUND_SHIPPING",
  "UNKNOWN_MARKETPLACE_FEE",
  "UNKNOWN_PROMOTED_FEE",
  "UNKNOWN_PAYMENT_FEE",
  "ORDER_LEVEL_COST_ALLOCATION_INCOMPLETE",
  "REFUND_CALCULATION_INCOMPLETE",
  "REFUND_PENDING",
  "RETURN_PENDING",
  "REVERSAL_COST_RECOVERY_INCOMPLETE",
  "FX_ANALYTICS_GAP",
] as const;
export const WARNING_ISSUE_CODES = ["ALLOCATION_AMBIGUOUS", "MISSING_CASH_COLLECTION_DATA", "SHIPPING_COST_ZERO_AMBIGUOUS"] as const;
export const CONFLICT_CODES = ["COST_BASIS_CONFLICT", "REVENUE_CASH_MISMATCH"] as const;
export const POLICY_FLAGS = ["VAT_POLICY_PROVISIONAL", "REVENUE_POLICY_PROVISIONAL"] as const;

export type BlockingIssueCode = (typeof BLOCKING_ISSUE_CODES)[number];
export type WarningIssueCode = (typeof WARNING_ISSUE_CODES)[number];
export type ProfitabilityIssueCode = BlockingIssueCode | WarningIssueCode;
export type ProfitabilityConflictCode = (typeof CONFLICT_CODES)[number];
export type ProfitabilityPolicyFlag = (typeof POLICY_FLAGS)[number];
export type ProfitStatus = "COMPLETE" | "PROVISIONAL" | "INCOMPLETE" | "NOT_SOLD";

// ---------------------------------------------------------------- source (resolved by service)

export interface ProfitabilityProductSource {
  readonly id: string;
  readonly sku: string;
  readonly title: string;
  readonly status: string;
  readonly brand: string | null;
  readonly categoryName: string | null;
  readonly noctellaId: string | null;
  readonly stockQuantity: number;
  readonly purchaseCost: number | null;
  readonly purchaseCurrency: string | null;
  readonly createdAt: string;
}

export interface ProfitabilityAllocationSource {
  readonly allocatedBuyerPremium: number | null;
  readonly allocatedShippingCost: number | null;
  readonly allocatedCustomsCost: number | null;
  readonly allocatedPackagingCost: number | null;
  readonly allocatedTaxVat: number | null;
  readonly allocatedMiscCost: number | null;
  readonly allocatedTotalCost: number;
}

export interface ProfitabilityPurchaseLineSource {
  readonly purchaseLineId: string;
  readonly purchaseId: string;
  readonly purchaseStatus: string;
  readonly purchaseCurrency: string;
  /** purchases.total_cost - null whenever any purchase-level cost component is unknown (existing totalOf semantics). */
  readonly purchaseTotalCost: number | null;
  readonly quantity: number;
  readonly unitPurchaseCost: number;
  readonly orderedAt: string | null;
  readonly purchaseReceivedAt: string | null;
  /** Earliest purchase_receipts.received_at that received a quantity of this line. */
  readonly firstReceiptAt: string | null;
  readonly allocation: ProfitabilityAllocationSource | null;
}

export interface ProfitabilitySaleSource {
  readonly orderId: string;
  readonly orderDraftId: string | null;
  readonly orderCurrency: string;
  readonly orderCreatedAt: string;
  readonly marketplaceChannel: string | null;
  readonly marketplaceOrderedAt: string | null;
  /** Every line of the order (not only this product's) - needed to detect multi-item orders. */
  readonly lines: readonly { readonly orderItemId: string; readonly productId: string; readonly quantity: number }[];
  readonly saleFinancials: {
    readonly grossRevenue: number;
    readonly shippingCharged: number;
    readonly shippingCost: number;
    readonly marketplaceFee: number | null;
    readonly promotedFee: number | null;
    readonly paymentFee: number | null;
    readonly taxVat: number;
    readonly itemCost: number;
    readonly netRevenue: number;
    readonly profit: number;
    readonly currency: string;
    readonly completedAt: string;
  };
  readonly payments: readonly { readonly status: string; readonly amount: number; readonly currency: string }[];
  readonly shipments: readonly { readonly status: string; readonly shippingCost: number; readonly currency: string; readonly carrierCode?: string | null }[];
  readonly refunds: readonly {
    readonly status: string;
    readonly currency: string;
    readonly subtotalAmount: number;
    readonly shippingAmount: number;
    readonly taxAmount: number;
    readonly totalAmount: number;
    readonly marketplaceFeeAdjustment: number | null;
    readonly paymentFeeAdjustment: number | null;
  }[];
  readonly returns: readonly {
    readonly status: string;
    readonly items: readonly { readonly orderItemId: string; readonly stockDisposition: string | null; readonly quantityCompleted: number | null }[];
  }[];
  readonly fullReversal: boolean;
}

export interface ProductProfitabilitySource {
  readonly product: ProfitabilityProductSource;
  readonly purchaseLines: readonly ProfitabilityPurchaseLineSource[];
  readonly sales: readonly ProfitabilitySaleSource[];
}

// ---------------------------------------------------------------- projection (output contract)

export type FeeStatus = "known" | "not_applicable" | "unknown";
export interface FeeValue { readonly amount: number | null; readonly status: FeeStatus }

export interface ProductCostBasis {
  readonly costBasisSource: "purchase_allocation" | "product_purchase_cost" | "missing";
  readonly productPurchaseCost: number | null;
  readonly purchaseLineBaseCost: number | null;
  readonly allocatedBuyerPremium: number | null;
  readonly allocatedInboundShipping: number | null;
  readonly allocatedCustoms: number | null;
  readonly allocatedPackaging: number | null;
  readonly allocatedPurchaseVat: number | null;
  readonly allocatedMisc: number | null;
  /** allocated_total_cost of the single valid quantity-1 line (base + every allocated component incl. VAT). */
  readonly allocationDerivedLandedCost: number | null;
  readonly landedCostInclInputVat: number | null;
  /** Only derivable from an allocation; unknown for a manual product cost of unknown composition. */
  readonly landedCostExInputVat: number | null;
  /** Per-unit cost used by the projection, selected by precedence + ProfitabilityPolicy. */
  readonly authoritativeLandedCost: number | null;
  readonly issueCodes: readonly ProfitabilityIssueCode[];
  readonly conflictCodes: readonly ProfitabilityConflictCode[];
}

export interface SaleAttemptProfitability {
  readonly orderId: string;
  readonly orderItemIds: readonly string[];
  readonly quantity: number;
  /** "order" when the order has other lines: order-level amounts are shown but NOT attributed to this product. */
  readonly amountScope: "item" | "order";
  readonly saleChannel: string;
  readonly saleDate: string;
  readonly completedAt: string;
  readonly daysAcquisitionToSale: number | null;
  readonly grossRevenue: number;
  readonly taxVat: number;
  readonly cashCollected: number | null;
  readonly grossVsCashDifference: number | null;
  readonly shippingCharged: number;
  readonly outboundShippingCost: number | null;
  readonly marketplaceFee: FeeValue;
  readonly promotedFee: FeeValue;
  readonly paymentFee: FeeValue;
  readonly refundAmount: number;
  readonly refundedShipping: number;
  readonly refundedTax: number;
  readonly refundedExVat: number | null;
  readonly marketplaceFeeAdjustment: number | null;
  readonly paymentFeeAdjustment: number | null;
  readonly returnState: "none" | "pending" | "completed";
  readonly restoredToStockQuantity: number;
  readonly fullReversal: boolean;
  /** Landed cost charged to this attempt: units restored to stock keep their cost in inventory (OD-6). */
  readonly costCharged: number | null;
  /** Same definition as sale_financials.netRevenue (gross - VAT - outbound shipping), additionally net of refunds. */
  readonly knownNetRevenue: number | null;
  /** Null unless every applicable component is known - never optimistic. */
  readonly knownProfit: number | null;
  /** Partial figure: excludes every UNKNOWN component (see issueCodes). Never a final profit. */
  readonly profitBeforeUnknownCosts: number | null;
  readonly marginPercent: number | null;
  readonly roiPercent: number | null;
  readonly recorded: { readonly grossRevenue: number; readonly netRevenue: number; readonly itemCost: number; readonly shippingCost: number; readonly profit: number };
  readonly profitStatus: Exclude<ProfitStatus, "NOT_SOLD">;
  readonly issueCodes: readonly ProfitabilityIssueCode[];
  readonly conflictCodes: readonly ProfitabilityConflictCode[];
  readonly policyFlags: readonly ProfitabilityPolicyFlag[];
}

export interface ProductProfitability {
  readonly productId: string;
  readonly sku: string;
  readonly noctellaId: string | null;
  readonly title: string;
  readonly category: string | null;
  readonly brand: string | null;
  readonly productStatus: string;
  readonly acquisitionDate: string;
  readonly acquisitionDateSource: "purchase_receipt" | "purchase_received" | "purchase_ordered" | "product_created";
  /** Days in stock up to `now`; null when nothing is currently in stock. */
  readonly inventoryAgeDays: number | null;
  readonly cost: ProductCostBasis;
  readonly saleAttempts: readonly SaleAttemptProfitability[];
  readonly profitStatus: ProfitStatus;
  readonly policy: ProfitabilityPolicy;
}

// ---------------------------------------------------------------- derivation

const EPSILON = 0.005;
const money = (n: number) => Math.round(n * 100) / 100;
const differs = (a: number, b: number) => Math.abs(a - b) >= 0.01;
const isEur = (currency: string | null | undefined) => currency == null || currency === "EUR";
const PENDING_REFUND_STATUSES = new Set(["draft", "pending", "submitted"]);
const TERMINAL_RETURN_STATUSES = new Set(["completed", "cancelled", "rejected", "closed"]);
const NON_INCURRED_SHIPMENT_STATUSES = new Set(["draft", "cancelled"]);
/** CarrierCode.LocalPickup (packages/shared enums/shipping.ts): the buyer collects - no outbound carrier cost exists. */
const LOCAL_PICKUP_CARRIER = "local_pickup";

function daysBetween(fromIso: string, to: Date): number | null {
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to.getTime())) return null;
  return Math.max(0, Math.floor((to.getTime() - from) / 86_400_000));
}

function deriveCostBasis(product: ProfitabilityProductSource, lines: readonly ProfitabilityPurchaseLineSource[], policy: ProfitabilityPolicy) {
  const issues: ProfitabilityIssueCode[] = [];
  const conflicts: ProfitabilityConflictCode[] = [];
  const candidates = lines.filter((line) => line.purchaseStatus !== "Cancelled");
  const allocated = candidates.filter((line) => line.allocation !== null);
  // Only a single quantity-1 line gives a defensible per-unit cost: allocated_total_cost is a
  // LINE total (quantity x unit + split components), and the existing purchase_cost sync applies
  // the same quantity===1 restriction. Several allocated lines or quantity > 1 = lot costing,
  // an unresolved owner decision - never guessed here.
  const valid = allocated.length === 1 && allocated[0]!.quantity === 1 ? allocated[0]! : null;
  if (!valid && allocated.length > 0) issues.push("ALLOCATION_AMBIGUOUS");
  if (valid && valid.purchaseTotalCost == null) issues.push("ALLOCATION_COMPONENTS_INCOMPLETE");
  if (!isEur(product.purchaseCurrency) || candidates.some((line) => !isEur(line.purchaseCurrency))) issues.push("FX_ANALYTICS_GAP");

  const a = valid?.allocation ?? null;
  const allocationTotal = a ? money(a.allocatedTotalCost) : null;
  const exVat = a ? money(a.allocatedTotalCost - (a.allocatedTaxVat ?? 0)) : null;
  const allocationCost = a ? (policy.inputVatInLandedCost === "include" ? allocationTotal : exVat) : null;
  const authoritative = allocationCost ?? product.purchaseCost;
  if (authoritative == null) issues.push("MISSING_COST_BASIS");
  if (allocationTotal != null && product.purchaseCost != null && differs(allocationTotal, product.purchaseCost)) conflicts.push("COST_BASIS_CONFLICT");

  const cost: ProductCostBasis = {
    costBasisSource: allocationCost != null ? "purchase_allocation" : product.purchaseCost != null ? "product_purchase_cost" : "missing",
    productPurchaseCost: product.purchaseCost,
    purchaseLineBaseCost: valid ? money(valid.quantity * valid.unitPurchaseCost) : null,
    allocatedBuyerPremium: a?.allocatedBuyerPremium ?? null,
    allocatedInboundShipping: a?.allocatedShippingCost ?? null,
    allocatedCustoms: a?.allocatedCustomsCost ?? null,
    allocatedPackaging: a?.allocatedPackagingCost ?? null,
    allocatedPurchaseVat: a?.allocatedTaxVat ?? null,
    allocatedMisc: a?.allocatedMiscCost ?? null,
    allocationDerivedLandedCost: allocationTotal,
    landedCostInclInputVat: allocationTotal ?? product.purchaseCost,
    landedCostExInputVat: exVat,
    authoritativeLandedCost: authoritative,
    issueCodes: issues,
    conflictCodes: conflicts,
  };
  return { cost, acquisitionLine: valid ?? (candidates.length === 1 ? candidates[0]! : null) };
}

function deriveAcquisition(product: ProfitabilityProductSource, line: ProfitabilityPurchaseLineSource | null) {
  if (line?.firstReceiptAt) return { date: line.firstReceiptAt, source: "purchase_receipt" as const };
  if (line?.purchaseReceivedAt) return { date: line.purchaseReceivedAt, source: "purchase_received" as const };
  if (line?.orderedAt) return { date: line.orderedAt, source: "purchase_ordered" as const };
  return { date: product.createdAt, source: "product_created" as const };
}

function fee(recorded: number | null, notApplicable: boolean): FeeValue {
  if (recorded != null) return { amount: recorded, status: "known" };
  return notApplicable ? { amount: null, status: "not_applicable" } : { amount: null, status: "unknown" };
}

function deriveSaleAttempt(
  productId: string,
  sale: ProfitabilitySaleSource,
  cost: ProductCostBasis,
  acquisitionDate: string,
  policy: ProfitabilityPolicy,
): SaleAttemptProfitability {
  const issues: ProfitabilityIssueCode[] = [...cost.issueCodes];
  const conflicts: ProfitabilityConflictCode[] = [...cost.conflictCodes];
  const sf = sale.saleFinancials;
  const productLines = sale.lines.filter((line) => line.productId === productId);
  const orderItemIds = productLines.map((line) => line.orderItemId);
  const quantity = productLines.reduce((total, line) => total + line.quantity, 0);
  // sale_financials is order-level only. With any other line in the order there is no existing
  // item-level shipping/fee/refund attribution, so nothing order-level is assigned to this product.
  const amountScope = sale.lines.length === 1 ? "item" : "order";
  if (amountScope === "order") issues.push("ORDER_LEVEL_COST_ALLOCATION_INCOMPLETE");

  const currencies = [sf.currency, sale.orderCurrency, ...sale.payments.map((p) => p.currency), ...sale.shipments.map((s) => s.currency), ...sale.refunds.map((r) => r.currency)];
  if (currencies.some((c) => !isEur(c)) && !issues.includes("FX_ANALYTICS_GAP")) issues.push("FX_ANALYTICS_GAP");

  // Cash collected: only the PaymentStatus.Paid state proves money was collected.
  const cashKnown = sale.payments.length > 0 && sale.payments.every((p) => p.status === "paid");
  const cashCollected = cashKnown ? money(sale.payments.reduce((total, p) => total + p.amount, 0)) : null;
  if (!cashKnown) issues.push("MISSING_CASH_COLLECTION_DATA");
  const grossVsCashDifference = cashCollected == null ? null : money(sf.grossRevenue - cashCollected);
  if (grossVsCashDifference != null && Math.abs(grossVsCashDifference) >= 0.01) conflicts.push("REVENUE_CASH_MISMATCH");

  // Outbound shipping EXPENSE (never shippingCharged, which is revenue-side). shipments.shipping_cost
  // is NOT NULL DEFAULT 0, so a 0 is indistinguishable from "never entered" -> unknown, not free.
  // Phase 1E: the only provable real zero is a CarrierCode.LocalPickup shipment (no outbound
  // carrier). Any other zero stays unknown and is flagged SHIPPING_COST_ZERO_AMBIGUOUS.
  const incurred = sale.shipments.filter((s) => !NON_INCURRED_SHIPMENT_STATUSES.has(s.status));
  const provenZero = (s: (typeof incurred)[number]) => s.shippingCost === 0 && s.carrierCode === LOCAL_PICKUP_CARRIER;
  const shippingKnown = incurred.length > 0 && incurred.every((s) => s.shippingCost > 0 || provenZero(s));
  const outboundShippingCost = shippingKnown ? money(incurred.reduce((total, s) => total + s.shippingCost, 0)) : null;
  if (!shippingKnown) issues.push("MISSING_OUTBOUND_SHIPPING");
  if (incurred.some((s) => s.shippingCost === 0 && !provenZero(s))) issues.push("SHIPPING_COST_ZERO_AMBIGUOUS");

  // Only proven NOT_APPLICABLE rule: a sale with no marketplace origin (no marketplace_orders link
  // and no marketplace import draft id) cannot carry a marketplace commission or a promoted-listing
  // fee. Payment fees have no provable rule (OWNER RULE REQUIRED) and stay unknown when null.
  const isMarketplaceSale = sale.marketplaceChannel != null || (sale.orderDraftId ?? "").startsWith("marketplace:");
  const marketplaceFee = fee(sf.marketplaceFee, !isMarketplaceSale);
  const promotedFee = fee(sf.promotedFee, !isMarketplaceSale);
  const paymentFee = fee(sf.paymentFee, false);
  if (marketplaceFee.status === "unknown") issues.push("UNKNOWN_MARKETPLACE_FEE");
  if (promotedFee.status === "unknown") issues.push("UNKNOWN_PROMOTED_FEE");
  if (paymentFee.status === "unknown") issues.push("UNKNOWN_PAYMENT_FEE");

  // Refunds: only `succeeded` refunds have economic effect. totalAmount already includes the
  // shipping and tax components, so they are never subtracted twice. The ex-VAT effect
  // (total - tax) is only trusted when the components reconcile to the total and the tax split is
  // explicit for a VAT-bearing sale; fee adjustments have no established sign convention in the
  // codebase, so they are surfaced but never applied.
  const succeeded = sale.refunds.filter((r) => r.status === "succeeded");
  if (sale.refunds.some((r) => PENDING_REFUND_STATUSES.has(r.status))) issues.push("REFUND_PENDING");
  const refundAmount = money(succeeded.reduce((total, r) => total + r.totalAmount, 0));
  const refundedShipping = money(succeeded.reduce((total, r) => total + r.shippingAmount, 0));
  const refundedTax = money(succeeded.reduce((total, r) => total + r.taxAmount, 0));
  const sumNullable = (values: (number | null)[]) => (values.every((v) => v == null) ? null : money(values.reduce<number>((total, v) => total + (v ?? 0), 0)));
  const marketplaceFeeAdjustment = sumNullable(succeeded.map((r) => r.marketplaceFeeAdjustment));
  const paymentFeeAdjustment = sumNullable(succeeded.map((r) => r.paymentFeeAdjustment));
  const refundReconciles = succeeded.every((r) => Math.abs(r.subtotalAmount + r.shippingAmount + r.taxAmount - r.totalAmount) < EPSILON);
  const vatSplitKnown = sf.taxVat <= 0 || succeeded.every((r) => r.taxAmount > 0);
  const refundComplete = refundReconciles && vatSplitKnown && marketplaceFeeAdjustment == null && paymentFeeAdjustment == null;
  const refundedExVat = refundComplete ? money(refundAmount - refundedTax) : null;
  if (!refundComplete) issues.push("REFUND_CALCULATION_INCOMPLETE");

  // Returns (OD-6): units restored to stock keep their landed cost in inventory, so they are not
  // charged to this attempt (and are charged again only if/when they resell - never twice).
  const pendingReturn = sale.returns.some((r) => !TERMINAL_RETURN_STATUSES.has(r.status));
  if (pendingReturn) issues.push("RETURN_PENDING");
  const completedItems = sale.returns.filter((r) => r.status === "completed").flatMap((r) => r.items).filter((item) => orderItemIds.includes(item.orderItemId));
  const restoredItems = completedItems.filter((item) => item.stockDisposition === "return_to_stock");
  const restoredToStockQuantity = Math.min(quantity, restoredItems.reduce((total, item) => total + (item.quantityCompleted ?? 0), 0));
  if (restoredItems.some((item) => item.quantityCompleted == null) || (sale.fullReversal && completedItems.length === 0)) issues.push("REVERSAL_COST_RECOVERY_INCOMPLETE");
  const returnState = pendingReturn ? "pending" : completedItems.length > 0 ? "completed" : "none";

  const unitCost = cost.authoritativeLandedCost;
  const costCharged = unitCost == null ? null : money(unitCost * (quantity - restoredToStockQuantity));
  const knownFees = [marketplaceFee, promotedFee, paymentFee].reduce((total, f) => total + (f.amount ?? 0), 0);
  const revenueExVatNetOfRefunds = refundedExVat == null ? null : money(sf.grossRevenue - sf.taxVat - refundedExVat);
  const knownNetRevenue = revenueExVatNetOfRefunds == null || outboundShippingCost == null ? null : money(revenueExVatNetOfRefunds - outboundShippingCost);

  const blocking = issues.some((code) => (BLOCKING_ISSUE_CODES as readonly string[]).includes(code));
  const knownProfit = !blocking && knownNetRevenue != null && costCharged != null ? money(knownNetRevenue - costCharged - knownFees) : null;
  const partialPossible = amountScope === "item" && !issues.includes("FX_ANALYTICS_GAP") && costCharged != null && revenueExVatNetOfRefunds != null;
  const profitBeforeUnknownCosts = partialPossible ? money(revenueExVatNetOfRefunds - (outboundShippingCost ?? 0) - costCharged - knownFees) : null;
  const marginPercent = knownProfit != null && revenueExVatNetOfRefunds != null && revenueExVatNetOfRefunds > 0 ? money((knownProfit / revenueExVatNetOfRefunds) * 100) : null;
  const roiPercent = knownProfit != null && costCharged != null && costCharged > 0 ? money((knownProfit / costCharged) * 100) : null;

  const policyFlags: ProfitabilityPolicyFlag[] = [];
  if (policy.inputVatPolicyProvisional) policyFlags.push("VAT_POLICY_PROVISIONAL");
  if (policy.revenuePolicyProvisional) policyFlags.push("REVENUE_POLICY_PROVISIONAL");
  const profitStatus = blocking ? "INCOMPLETE" : policyFlags.length > 0 || conflicts.length > 0 ? "PROVISIONAL" : "COMPLETE";
  const saleDate = sale.marketplaceOrderedAt ?? sale.orderCreatedAt;

  return {
    orderId: sale.orderId,
    orderItemIds,
    quantity,
    amountScope,
    saleChannel: sale.marketplaceChannel ?? "Internal",
    saleDate,
    completedAt: sf.completedAt,
    daysAcquisitionToSale: daysBetween(acquisitionDate, new Date(saleDate)),
    grossRevenue: sf.grossRevenue,
    taxVat: sf.taxVat,
    cashCollected,
    grossVsCashDifference,
    shippingCharged: sf.shippingCharged,
    outboundShippingCost,
    marketplaceFee,
    promotedFee,
    paymentFee,
    refundAmount,
    refundedShipping,
    refundedTax,
    refundedExVat,
    marketplaceFeeAdjustment,
    paymentFeeAdjustment,
    returnState,
    restoredToStockQuantity,
    fullReversal: sale.fullReversal,
    costCharged,
    knownNetRevenue,
    knownProfit,
    profitBeforeUnknownCosts,
    marginPercent,
    roiPercent,
    recorded: { grossRevenue: sf.grossRevenue, netRevenue: sf.netRevenue, itemCost: sf.itemCost, shippingCost: sf.shippingCost, profit: sf.profit },
    profitStatus,
    issueCodes: issues,
    conflictCodes: conflicts,
    policyFlags,
  };
}

export function projectProductProfitability(
  source: ProductProfitabilitySource,
  now: Date,
  policy: ProfitabilityPolicy = PROVISIONAL_PROFITABILITY_POLICY,
): ProductProfitability {
  const { product } = source;
  const { cost, acquisitionLine } = deriveCostBasis(product, source.purchaseLines, policy);
  const acquisition = deriveAcquisition(product, acquisitionLine);
  const saleAttempts = source.sales.map((sale) => deriveSaleAttempt(product.id, sale, cost, acquisition.date, policy));
  const profitStatus: ProfitStatus =
    saleAttempts.length === 0
      ? "NOT_SOLD"
      : saleAttempts.some((s) => s.profitStatus === "INCOMPLETE")
        ? "INCOMPLETE"
        : saleAttempts.some((s) => s.profitStatus === "PROVISIONAL")
          ? "PROVISIONAL"
          : "COMPLETE";

  return {
    productId: product.id,
    sku: product.sku,
    noctellaId: product.noctellaId,
    title: product.title,
    category: product.categoryName,
    brand: product.brand,
    productStatus: product.status,
    acquisitionDate: acquisition.date,
    acquisitionDateSource: acquisition.source,
    inventoryAgeDays: product.stockQuantity > 0 ? daysBetween(acquisition.date, now) : null,
    cost,
    saleAttempts,
    profitStatus,
    policy,
  };
}
