// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getProductProfitability, getProductProfitabilityInsights } from "../src/services/productProfitability";
import { deriveProfitabilityInsights, type AnalyticsInsight } from "../src/use-cases/analytics/profitabilityInsights";
import {
  projectProductProfitability,
  type ProductProfitability,
  type ProductProfitabilitySource,
  type ProfitabilityPurchaseLineSource,
  type ProfitabilitySaleSource,
  type SaleAttemptProfitability,
} from "../src/use-cases/analytics/productProfitability";

/**
 * Analytics Phase 1C: deterministic, advisory profitability insights derived only from the
 * Phase 1B ProductProfitability projection. Fixtures run the real Phase 1B projection; nothing
 * in the profitability model is mocked.
 */

const NOW = new Date("2026-10-01T00:00:00.000Z");

function line(overrides: Partial<ProfitabilityPurchaseLineSource> = {}): ProfitabilityPurchaseLineSource {
  return {
    purchaseLineId: "pl-1", purchaseId: "pu-1", purchaseStatus: "Received", purchaseCurrency: "EUR", purchaseTotalCost: 60,
    quantity: 1, unitPurchaseCost: 40, orderedAt: "2026-01-05T00:00:00.000Z", purchaseReceivedAt: "2026-01-20T00:00:00.000Z", firstReceiptAt: "2026-01-15T00:00:00.000Z",
    allocation: { allocatedBuyerPremium: 5, allocatedShippingCost: 3, allocatedCustomsCost: 0, allocatedPackagingCost: 1, allocatedTaxVat: 2, allocatedMiscCost: 1, allocatedTotalCost: 52 },
    ...overrides,
  };
}

/** Baseline: fully known, conflict-free, non-marketplace sale -> PROVISIONAL, knownProfit 50, no insights. */
function sale(overrides: Partial<ProfitabilitySaleSource> = {}, financials: Partial<ProfitabilitySaleSource["saleFinancials"]> = {}): ProfitabilitySaleSource {
  return {
    orderId: "o-1", orderDraftId: "draft-1", orderCurrency: "EUR", orderCreatedAt: "2026-03-01T00:00:00.000Z", marketplaceChannel: null, marketplaceOrderedAt: null,
    lines: [{ orderItemId: "oi-1", productId: "p-1", quantity: 1 }],
    saleFinancials: { grossRevenue: 132, shippingCharged: 10, shippingCost: 5, marketplaceFee: null, promotedFee: null, paymentFee: 3, taxVat: 22, itemCost: 52, netRevenue: 105, profit: 53, currency: "EUR", completedAt: "2026-03-10T00:00:00.000Z", ...financials },
    payments: [{ status: "paid", amount: financials.grossRevenue ?? 132, currency: "EUR" }],
    shipments: [{ status: "delivered", shippingCost: 5, currency: "EUR" }],
    refunds: [],
    returns: [],
    fullReversal: false,
    ...overrides,
  };
}

function project(overrides: { product?: Partial<ProductProfitabilitySource["product"]>; purchaseLines?: ProfitabilityPurchaseLineSource[]; sales?: ProfitabilitySaleSource[] } = {}): ProductProfitability {
  return projectProductProfitability(
    {
      product: { id: "p-1", sku: "SKU-1", title: "Brass clock", status: "sold", brand: null, categoryName: "Clocks", noctellaId: "N-1", stockQuantity: 0, purchaseCost: 52, purchaseCurrency: "EUR", createdAt: "2026-02-01T00:00:00.000Z", ...overrides.product },
      purchaseLines: overrides.purchaseLines ?? [line()],
      sales: overrides.sales ?? [sale()],
    },
    NOW,
  );
}

/** Contract-level patch of the first sale attempt, used only to exercise suppression rules directly. */
function patchAttempt(pp: ProductProfitability, patch: Partial<SaleAttemptProfitability>): ProductProfitability {
  return { ...pp, saleAttempts: [{ ...pp.saleAttempts[0]!, ...patch }] };
}

const derive = (pp: ProductProfitability) => deriveProfitabilityInsights(pp, NOW);
const codes = (insights: AnalyticsInsight[]) => insights.map((i) => i.code);
const find = (insights: AnalyticsInsight[], code: string) => insights.find((i) => i.code === code);
const fact = (insight: AnalyticsInsight | undefined, path: string) => insight?.evidence.find((e) => e.fact === path);

// 132 gross / 22 VAT / 5 shipping / 52 cost / 3 fee -> knownProfit 50. Lower gross for losses:
const lossFinancials = { grossRevenue: 60, taxVat: 10 }; // 60 - 10 - 5 - 52 - 3 = -10

describe("Phase 1C baseline", () => {
  it("a fully known, conflict-free profitable sale produces no Phase 1C problem insights (Phase 1E: only HIGH_MARGIN at 45.45%)", () => {
    const pp = project();
    expect(pp.profitStatus).toBe("PROVISIONAL");
    expect(codes(derive(pp))).toEqual(["HIGH_MARGIN"]);
  });
});

describe("Phase 1C signals", () => {
  it("COST_BASIS_MISSING fires for a missing cost basis, product-level, HIGH, FINANCE", () => {
    const insight = find(derive(project({ purchaseLines: [], product: { purchaseCost: null } })), "COST_BASIS_MISSING");
    expect(insight).toMatchObject({ entityType: "product", entityId: "p-1", severity: "warning", confidence: "HIGH", routingTarget: "FINANCE" });
    expect(fact(insight, "cost.costBasisSource")?.value).toBe("missing");
    expect(fact(insight, "cost.authoritativeLandedCost")?.value).toBeNull();
    expect(insight!.evidence).toContainEqual({ fact: "cost.issueCode", value: "MISSING_COST_BASIS" });
  });

  it("COST_BASIS_MISSING stays silent when a cost basis exists", () => {
    expect(codes(derive(project()))).not.toContain("COST_BASIS_MISSING");
  });

  it("COST_BASIS_CONFLICT fires with both cost sources and the authoritative cost as evidence", () => {
    const insight = find(derive(project({ product: { purchaseCost: 40 } })), "COST_BASIS_CONFLICT");
    expect(insight).toMatchObject({ entityType: "product", severity: "warning", confidence: "HIGH", routingTarget: "FINANCE" });
    expect(fact(insight, "cost.allocationDerivedLandedCost")?.value).toBe(52);
    expect(fact(insight, "cost.productPurchaseCost")?.value).toBe(40);
    expect(fact(insight, "cost.authoritativeLandedCost")?.value).toBe(52);
    expect(insight!.evidence).toContainEqual({ fact: "cost.conflictCode", value: "COST_BASIS_CONFLICT" });
  });

  it("COST_BASIS_CONFLICT stays silent when the sources agree", () => {
    expect(codes(derive(project()))).not.toContain("COST_BASIS_CONFLICT");
  });

  it("SHIPPING_COST_MISSING fires per sale attempt with the unknown cost kept null (not 0)", () => {
    const insight = find(derive(project({ sales: [sale({ shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR" }] })] })), "SHIPPING_COST_MISSING");
    expect(insight).toMatchObject({ entityType: "sale_attempt", orderId: "o-1", severity: "warning", confidence: "MEDIUM", routingTarget: "OPERATIONS" });
    expect(fact(insight, "saleAttempts[o-1].outboundShippingCost")?.value).toBeNull();
    expect(insight!.evidence).toContainEqual({ fact: "saleAttempts[o-1].issueCode", value: "MISSING_OUTBOUND_SHIPPING" });
  });

  it("SHIPPING_COST_MISSING stays silent when the shipping cost is known", () => {
    expect(codes(derive(project()))).not.toContain("SHIPPING_COST_MISSING");
  });

  it("REVENUE_CASH_MISMATCH fires with revenue, cash, difference, conflict and revenue policy flag", () => {
    const insight = find(derive(project({ sales: [sale({ payments: [{ status: "paid", amount: 110, currency: "EUR" }] })] })), "REVENUE_CASH_MISMATCH");
    expect(insight).toMatchObject({ entityType: "sale_attempt", severity: "warning", confidence: "MEDIUM", routingTarget: "FINANCE" });
    expect(fact(insight, "saleAttempts[o-1].grossRevenue")?.value).toBe(132);
    expect(fact(insight, "saleAttempts[o-1].cashCollected")?.value).toBe(110);
    expect(fact(insight, "saleAttempts[o-1].grossVsCashDifference")?.value).toBe(22);
    expect(insight!.evidence).toContainEqual({ fact: "saleAttempts[o-1].conflictCode", value: "REVENUE_CASH_MISMATCH" });
    expect(insight!.evidence).toContainEqual({ fact: "saleAttempts[o-1].policyFlag", value: "REVENUE_POLICY_PROVISIONAL" });
  });

  it("REVENUE_CASH_MISMATCH stays silent when revenue and cash agree", () => {
    expect(codes(derive(project()))).not.toContain("REVENUE_CASH_MISMATCH");
  });

  it("NEGATIVE_PROFIT fires from knownProfit < 0 (critical, PRICING, MEDIUM under provisional policy)", () => {
    const pp = project({ sales: [sale({}, lossFinancials)] });
    expect(pp.saleAttempts[0]!.knownProfit).toBe(-10);
    const insight = find(derive(pp), "NEGATIVE_PROFIT");
    expect(insight).toMatchObject({ entityType: "sale_attempt", orderId: "o-1", severity: "critical", confidence: "MEDIUM", routingTarget: "PRICING" });
    expect(fact(insight, "saleAttempts[o-1].knownProfit")?.value).toBe(-10);
    expect(insight!.evidence).toContainEqual({ fact: "saleAttempts[o-1].policyFlag", value: "VAT_POLICY_PROVISIONAL" });
  });

  it("NEGATIVE_PROFIT fires from the profitBeforeUnknownCosts upper bound while knownProfit is unknown", () => {
    const pp = project({ sales: [sale({}, { ...lossFinancials, paymentFee: null })] });
    expect(pp.saleAttempts[0]!.knownProfit).toBeNull();
    expect(pp.saleAttempts[0]!.profitBeforeUnknownCosts).toBe(-7);
    const insight = find(derive(pp), "NEGATIVE_PROFIT");
    expect(insight).toMatchObject({ confidence: "MEDIUM" });
    expect(fact(insight, "saleAttempts[o-1].knownProfit")?.value).toBeNull();
    expect(fact(insight, "saleAttempts[o-1].paymentFee.status")?.value).toBe("unknown");
    expect(insight!.evidence).toContainEqual({ fact: "saleAttempts[o-1].issueCode", value: "UNKNOWN_PAYMENT_FEE" });
  });

  it("NEGATIVE_PROFIT stays silent for non-negative results", () => {
    expect(codes(derive(project()))).not.toContain("NEGATIVE_PROFIT");
    expect(codes(derive(project({ sales: [sale({}, { paymentFee: null })] })))).not.toContain("NEGATIVE_PROFIT");
  });

  it.each([
    ["RETURN_PENDING", { issueCodes: ["RETURN_PENDING"] }],
    ["REVERSAL_COST_RECOVERY_INCOMPLETE", { issueCodes: ["REVERSAL_COST_RECOVERY_INCOMPLETE"] }],
    ["FX_ANALYTICS_GAP", { issueCodes: ["FX_ANALYTICS_GAP"] }],
    ["amountScope === order", { amountScope: "order" }],
  ] as const)("NEGATIVE_PROFIT is suppressed by %s", (_label, patch) => {
    const pp = project({ sales: [sale({}, lossFinancials)] });
    const patched = patchAttempt(pp, { ...patch, issueCodes: [...pp.saleAttempts[0]!.issueCodes, ...("issueCodes" in patch ? patch.issueCodes : [])] } as Partial<SaleAttemptProfitability>);
    expect(codes(derive(patched))).not.toContain("NEGATIVE_PROFIT");
  });

  it("NEGATIVE_PROFIT is suppressed end-to-end by a pending return in the real projection", () => {
    expect(codes(derive(project({ sales: [sale({ returns: [{ status: "received", items: [] }] }, lossFinancials)] })))).not.toContain("NEGATIVE_PROFIT");
  });

  it("PROFITABILITY_INCOMPLETE is ONE product-level insight carrying every blocking code as evidence", () => {
    const pp = project({ sales: [sale({ marketplaceChannel: "ebay", shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR" }] }, { paymentFee: null })] });
    const insights = derive(pp).filter((i) => i.code === "PROFITABILITY_INCOMPLETE");
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ entityType: "product", severity: "info", confidence: "HIGH", routingTarget: "FINANCE", dataCompleteness: "INCOMPLETE" });
    const issueValues = insights[0]!.evidence.filter((e) => e.fact === "saleAttempts[o-1].issueCode").map((e) => e.value);
    expect(issueValues).toEqual(expect.arrayContaining(["MISSING_OUTBOUND_SHIPPING", "UNKNOWN_MARKETPLACE_FEE", "UNKNOWN_PROMOTED_FEE", "UNKNOWN_PAYMENT_FEE"]));
    expect(fact(insights[0], "profitStatus")?.value).toBe("INCOMPLETE");
  });

  it("UNKNOWN_PAYMENT_FEE never becomes its own insight - only evidence", () => {
    const insights = derive(project({ sales: [sale({}, { paymentFee: null })] }));
    expect(codes(insights)).toEqual(["PROFITABILITY_INCOMPLETE"]);
    expect(insights[0]!.evidence).toContainEqual({ fact: "saleAttempts[o-1].issueCode", value: "UNKNOWN_PAYMENT_FEE" });
  });
});

describe("Phase 1C confidence, keys, safety, routing", () => {
  it("financial outcome with a conflict or ALLOCATION_AMBIGUOUS is LOW", () => {
    const conflict = find(derive(project({ product: { purchaseCost: 40 }, sales: [sale({}, lossFinancials)] })), "NEGATIVE_PROFIT");
    expect(conflict?.confidence).toBe("LOW");
    const ambiguous = find(derive(project({ purchaseLines: [line(), line({ purchaseLineId: "pl-2" })], sales: [sale({}, lossFinancials)] })), "NEGATIVE_PROFIT");
    expect(ambiguous?.confidence).toBe("LOW");
    expect(ambiguous!.evidence).toContainEqual({ fact: "saleAttempts[o-1].issueCode", value: "ALLOCATION_AMBIGUOUS" });
  });

  it("factual signals are HIGH; HIGH for a financial outcome stays unreachable under provisional policies", () => {
    const insights = derive(project({ product: { purchaseCost: 40 }, sales: [sale({ shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR" }] }, lossFinancials)] }));
    expect(find(insights, "COST_BASIS_CONFLICT")?.confidence).toBe("HIGH");
    expect(find(insights, "PROFITABILITY_INCOMPLETE")?.confidence).toBe("HIGH");
    expect(insights.filter((i) => i.code === "NEGATIVE_PROFIT").every((i) => i.confidence !== "HIGH")).toBe(true);
  });

  it("keys are deterministic across calls and follow code:entityType:entityId[:orderId]", () => {
    const pp = project({ product: { purchaseCost: 40 }, sales: [sale({}, { ...lossFinancials, paymentFee: null })] });
    const first = derive(pp).map((i) => i.key);
    expect(derive(pp).map((i) => i.key)).toEqual(first);
    expect(first).toEqual(["COST_BASIS_CONFLICT:product:p-1", "PROFITABILITY_INCOMPLETE:product:p-1", "NEGATIVE_PROFIT:sale_attempt:p-1:o-1"]);
  });

  it("every insight is advisoryOnly and routed per the approved matrix", () => {
    const insights = [
      ...derive(project({ purchaseLines: [], product: { purchaseCost: null } })),
      ...derive(project({ product: { purchaseCost: 40 }, sales: [sale({ payments: [{ status: "paid", amount: 110, currency: "EUR" }], shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR" }] }, { ...lossFinancials, paymentFee: null })] })),
    ];
    const expected: Record<string, string> = { COST_BASIS_MISSING: "FINANCE", COST_BASIS_CONFLICT: "FINANCE", SHIPPING_COST_MISSING: "OPERATIONS", REVENUE_CASH_MISMATCH: "FINANCE", NEGATIVE_PROFIT: "PRICING", PROFITABILITY_INCOMPLETE: "FINANCE" };
    expect(new Set(codes(insights))).toEqual(new Set(Object.keys(expected)));
    for (const insight of insights) {
      expect(insight.advisoryOnly).toBe(true);
      expect(insight.routingTarget).toBe(expected[insight.code]);
      expect(insight.evaluatedAt).toBe(NOW.toISOString());
    }
  });

  it("NOT_SOLD products produce no financial-outcome signals; only the factual cost signal may apply", () => {
    expect(derive(project({ sales: [] }))).toEqual([]);
    const missing = derive(project({ sales: [], purchaseLines: [], product: { purchaseCost: null } }));
    expect(codes(missing)).toEqual(["COST_BASIS_MISSING"]);
    expect(missing[0]!.dataCompleteness).toBe("NOT_SOLD");
  });
});

describe("Phase 1C service - read-only integration", () => {
  const TABLES = ["products", "purchases", "purchase_lines", "purchase_allocations", "purchase_receipts", "purchase_receipt_lines", "orders", "order_items", "sale_financials", "payments", "shipments", "refunds", "return_requests", "return_items", "sale_reversals", "finance_entries", "stock_movements"];
  const t = "2026-03-01T00:00:00.000Z";

  it("derives insights from the Phase 1B read model with no database mutation", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const db = drizzle(sqlite, { schema }) as any;
    db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Brass clock", slug: "brass-clock", type: "unique_item", status: "sold", stockQuantity: 0, purchaseCost: 40, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
    db.insert(schema.purchases).values({ id: "pu-1", sourceType: "Auction", currency: "EUR", itemSubtotal: 40, totalCost: 52, status: "Received" }).run();
    db.insert(schema.purchaseLines).values({ id: "pl-1", purchaseId: "pu-1", productId: "p-1", titleSnapshot: "Brass clock", quantity: 1, receivedQuantity: 1, unitPurchaseCost: 40 }).run();
    db.insert(schema.purchaseAllocations).values({ id: "pa-1", purchaseId: "pu-1", purchaseLineId: "pl-1", productId: "p-1", allocationMethod: "Equal", allocatedTaxVat: 2, allocatedTotalCost: 52 }).run();
    db.insert(schema.orders).values({ id: "o-1", orderNumber: "N-1", orderDraftId: "draft-1", guestEmail: "a@example.invalid", status: "completed", paymentStatus: "paid", subtotalAmount: 110, shippingAmount: 10, totalAmount: 132, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: t, updatedAt: t }).run();
    db.insert(schema.orderItems).values({ id: "oi-1", orderId: "o-1", productId: "p-1", productSku: "SKU-1", productTitle: "Brass clock", productSlug: "brass-clock", productType: "unique_item", quantity: 1, unitPrice: 110, totalPrice: 110, currency: "EUR" }).run();
    db.insert(schema.saleFinancials).values({ id: "sf-1", orderId: "o-1", grossRevenue: 132, shippingCharged: 10, shippingCost: 5, taxVat: 22, itemCost: 40, netRevenue: 105, profit: 65, currency: "EUR", sourceSnapshot: "{}", completedAt: "2026-03-10T00:00:00.000Z" }).run();
    db.insert(schema.payments).values({ id: "pay-1", orderId: "o-1", provider: "cash_on_delivery", status: "paid", amount: 132, currency: "EUR", idempotencyKey: "pay-1" }).run();
    db.insert(schema.shipments).values({ id: "sh-1", orderId: "o-1", carrierCode: "other", status: "delivered", shippingCost: 5, currency: "EUR" }).run();

    const dump = () => Object.fromEntries(TABLES.map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = dump();
    const insights = getProductProfitabilityInsights(db, "p-1", NOW);
    expect(dump()).toEqual(before);

    expect(insights).toEqual(deriveProfitabilityInsights(getProductProfitability(db, "p-1", NOW), NOW));
    expect(codes(insights)).toEqual(["COST_BASIS_CONFLICT", "PROFITABILITY_INCOMPLETE"]);
  });
});
