// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getProductProfitability } from "../src/services/productProfitability";
import {
  projectProductProfitability,
  type ProductProfitabilitySource,
  type ProfitabilityPurchaseLineSource,
  type ProfitabilitySaleSource,
} from "../src/use-cases/analytics/productProfitability";

/**
 * Analytics Phase 1B: deterministic product profitability projection. Pure cases build the
 * source directly; the final case runs the real read repository against an in-memory SQLite
 * database and proves the projection performs no writes.
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

function sale(overrides: Partial<ProfitabilitySaleSource> = {}): ProfitabilitySaleSource {
  return {
    orderId: "o-1", orderDraftId: "draft-1", orderCurrency: "EUR", orderCreatedAt: "2026-03-01T00:00:00.000Z", marketplaceChannel: null, marketplaceOrderedAt: null,
    lines: [{ orderItemId: "oi-1", productId: "p-1", quantity: 1 }],
    saleFinancials: { grossRevenue: 132, shippingCharged: 10, shippingCost: 5, marketplaceFee: null, promotedFee: null, paymentFee: 3, taxVat: 22, itemCost: 52, netRevenue: 105, profit: 53, currency: "EUR", completedAt: "2026-03-10T00:00:00.000Z" },
    payments: [{ status: "paid", amount: 132, currency: "EUR" }],
    shipments: [{ status: "delivered", shippingCost: 5, currency: "EUR" }],
    refunds: [],
    returns: [],
    fullReversal: false,
    ...overrides,
  };
}

function source(overrides: { product?: Partial<ProductProfitabilitySource["product"]>; purchaseLines?: ProfitabilityPurchaseLineSource[]; sales?: ProfitabilitySaleSource[] } = {}): ProductProfitabilitySource {
  return {
    product: { id: "p-1", sku: "SKU-1", title: "Brass clock", status: "sold", brand: null, categoryName: "Clocks", noctellaId: "N-1", stockQuantity: 0, purchaseCost: 52, purchaseCurrency: "EUR", createdAt: "2026-02-01T00:00:00.000Z", ...overrides.product },
    purchaseLines: overrides.purchaseLines ?? [line()],
    sales: overrides.sales ?? [sale()],
  };
}

describe("Phase 1B product profitability - cost basis (OD-1, OD-2)", () => {
  it("valid quantity-1 allocation wins as the authoritative landed cost, with its full breakdown", () => {
    const r = projectProductProfitability(source(), NOW);
    expect(r.cost.costBasisSource).toBe("purchase_allocation");
    expect(r.cost.authoritativeLandedCost).toBe(52);
    expect(r.cost).toMatchObject({ purchaseLineBaseCost: 40, allocatedBuyerPremium: 5, allocatedInboundShipping: 3, allocatedPackaging: 1, allocatedPurchaseVat: 2, allocatedMisc: 1, allocationDerivedLandedCost: 52 });
    expect(r.cost.conflictCodes).toEqual([]);
  });

  it("allocation and product purchase cost differ -> allocation used, COST_BASIS_CONFLICT exposed, both sources visible", () => {
    const r = projectProductProfitability(source({ product: { purchaseCost: 40 } }), NOW);
    expect(r.cost.authoritativeLandedCost).toBe(52);
    expect(r.cost.productPurchaseCost).toBe(40);
    expect(r.cost.conflictCodes).toEqual(["COST_BASIS_CONFLICT"]);
    expect(r.saleAttempts[0]!.conflictCodes).toContain("COST_BASIS_CONFLICT");
  });

  it("no allocation -> falls back to products.purchase_cost", () => {
    const r = projectProductProfitability(source({ purchaseLines: [line({ allocation: null })], product: { purchaseCost: 47 } }), NOW);
    expect(r.cost.costBasisSource).toBe("product_purchase_cost");
    expect(r.cost.authoritativeLandedCost).toBe(47);
    expect(r.cost.landedCostExInputVat).toBeNull();
  });

  it("quantity > 1 allocation is never divided by guesswork -> ALLOCATION_AMBIGUOUS and fallback", () => {
    const r = projectProductProfitability(source({ purchaseLines: [line({ quantity: 3 })], product: { purchaseCost: 47 } }), NOW);
    expect(r.cost.costBasisSource).toBe("product_purchase_cost");
    expect(r.cost.issueCodes).toContain("ALLOCATION_AMBIGUOUS");
  });

  it("missing cost -> MISSING_COST_BASIS, knownProfit null, status INCOMPLETE", () => {
    const r = projectProductProfitability(source({ purchaseLines: [], product: { purchaseCost: null } }), NOW);
    expect(r.cost.costBasisSource).toBe("missing");
    expect(r.saleAttempts[0]!.issueCodes).toContain("MISSING_COST_BASIS");
    expect(r.saleAttempts[0]!.knownProfit).toBeNull();
    expect(r.saleAttempts[0]!.profitBeforeUnknownCosts).toBeNull();
    expect(r.profitStatus).toBe("INCOMPLETE");
  });

  it("OD-2 provisional: input VAT included by default; an injected exclude policy switches without data changes", () => {
    expect(projectProductProfitability(source(), NOW).cost.authoritativeLandedCost).toBe(52);
    const excluded = projectProductProfitability(source(), NOW, { inputVatInLandedCost: "exclude", inputVatPolicyProvisional: false, revenuePolicyProvisional: true });
    expect(excluded.cost.authoritativeLandedCost).toBe(50);
    expect(excluded.cost.landedCostInclInputVat).toBe(52);
  });

  it("acquisition date prefers the purchase receipt and exposes its source; product creation is only a labelled fallback", () => {
    expect(projectProductProfitability(source(), NOW)).toMatchObject({ acquisitionDate: "2026-01-15T00:00:00.000Z", acquisitionDateSource: "purchase_receipt" });
    const fallback = projectProductProfitability(source({ purchaseLines: [], product: { stockQuantity: 1 }, sales: [] }), NOW);
    expect(fallback).toMatchObject({ acquisitionDateSource: "product_created", inventoryAgeDays: 242, profitStatus: "NOT_SOLD" });
  });
});

describe("Phase 1B product profitability - sale costs and fees (OD-4)", () => {
  it("null fees stay UNKNOWN (never zero) on a marketplace sale", () => {
    const s = projectProductProfitability(source({ sales: [sale({ marketplaceChannel: "ebay" })] }), NOW).saleAttempts[0]!;
    expect(s.marketplaceFee).toEqual({ amount: null, status: "unknown" });
    expect(s.promotedFee).toEqual({ amount: null, status: "unknown" });
    expect(s.issueCodes).toEqual(expect.arrayContaining(["UNKNOWN_MARKETPLACE_FEE", "UNKNOWN_PROMOTED_FEE"]));
    expect(s.knownProfit).toBeNull();
    expect(s.profitStatus).toBe("INCOMPLETE");
  });

  it("proven rule: a non-marketplace sale has NOT_APPLICABLE marketplace/promoted fees; a null payment fee stays UNKNOWN", () => {
    const s = projectProductProfitability(source({ sales: [sale({ saleFinancials: { ...sale().saleFinancials, paymentFee: null } })] }), NOW).saleAttempts[0]!;
    expect(s.marketplaceFee.status).toBe("not_applicable");
    expect(s.promotedFee.status).toBe("not_applicable");
    expect(s.paymentFee).toEqual({ amount: null, status: "unknown" });
    expect(s.issueCodes).toContain("UNKNOWN_PAYMENT_FEE");
  });

  it("a marketplace import draft id alone is enough to keep marketplace fees unknown", () => {
    const s = projectProductProfitability(source({ sales: [sale({ orderDraftId: "marketplace:etsy:123" })] }), NOW).saleAttempts[0]!;
    expect(s.marketplaceFee.status).toBe("unknown");
  });

  it("all components known -> knownProfit equals the sale_financials-consistent formula; status PROVISIONAL with policy flags", () => {
    const s = projectProductProfitability(source(), NOW).saleAttempts[0]!;
    // 132 gross - 22 VAT - 5 outbound shipping = 105 (same as recorded netRevenue); - 52 cost - 3 payment fee
    expect(s.knownNetRevenue).toBe(105);
    expect(s.knownProfit).toBe(50);
    expect(s.marginPercent).toBe(45.45);
    expect(s.roiPercent).toBe(96.15);
    expect(s.recorded.profit).toBe(53);
    expect(s.profitStatus).toBe("PROVISIONAL");
    expect(s.policyFlags).toEqual(["VAT_POLICY_PROVISIONAL", "REVENUE_POLICY_PROVISIONAL"]);
  });

  it("shipping charged (revenue) is never used as outbound shipping expense; an unentered 0 cost stays unknown", () => {
    const s = projectProductProfitability(source({ sales: [sale({ shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR" }] })] }), NOW).saleAttempts[0]!;
    expect(s.shippingCharged).toBe(10);
    expect(s.outboundShippingCost).toBeNull();
    expect(s.issueCodes).toContain("MISSING_OUTBOUND_SHIPPING");
    expect(s.knownProfit).toBeNull();
  });

  it("outbound shipping sums every incurred shipment, ignoring draft/cancelled ones", () => {
    const shipments = [{ status: "delivered", shippingCost: 5, currency: "EUR" }, { status: "returned", shippingCost: 4, currency: "EUR" }, { status: "cancelled", shippingCost: 9, currency: "EUR" }];
    expect(projectProductProfitability(source({ sales: [sale({ shipments })] }), NOW).saleAttempts[0]!.outboundShippingCost).toBe(9);
  });

  it("gross revenue stays sale_financials.grossRevenue; a cash difference is exposed, not hidden", () => {
    const s = projectProductProfitability(source({ sales: [sale({ payments: [{ status: "paid", amount: 110, currency: "EUR" }] })] }), NOW).saleAttempts[0]!;
    expect(s.grossRevenue).toBe(132);
    expect(s.cashCollected).toBe(110);
    expect(s.grossVsCashDifference).toBe(22);
    expect(s.conflictCodes).toContain("REVENUE_CASH_MISMATCH");
  });

  it("non-paid payment states never count as cash collected", () => {
    const s = projectProductProfitability(source({ sales: [sale({ payments: [{ status: "pending", amount: 132, currency: "EUR" }] })] }), NOW).saleAttempts[0]!;
    expect(s.cashCollected).toBeNull();
    expect(s.issueCodes).toContain("MISSING_CASH_COLLECTION_DATA");
  });

  it("a non-EUR record is flagged FX_ANALYTICS_GAP, never converted", () => {
    const s = projectProductProfitability(source({ sales: [sale({ orderCurrency: "USD" })] }), NOW).saleAttempts[0]!;
    expect(s.issueCodes).toContain("FX_ANALYTICS_GAP");
    expect(s.knownProfit).toBeNull();
  });
});

describe("Phase 1B product profitability - refunds, reversals, multi-item (OD-6)", () => {
  const partialRefund = { status: "succeeded", currency: "EUR", subtotalAmount: 10, shippingAmount: 0, taxAmount: 2, totalAmount: 12, marketplaceFeeAdjustment: null, paymentFeeAdjustment: null };

  it("a succeeded refund reduces revenue by its ex-VAT part only (total already includes shipping/tax - no double subtraction)", () => {
    const s = projectProductProfitability(source({ sales: [sale({ refunds: [partialRefund] })] }), NOW).saleAttempts[0]!;
    expect(s.refundAmount).toBe(12);
    expect(s.refundedTax).toBe(2);
    expect(s.refundedExVat).toBe(10);
    expect(s.knownProfit).toBe(40);
  });

  it("refund components that do not reconcile, or a missing VAT split on a VAT-bearing sale -> REFUND_CALCULATION_INCOMPLETE", () => {
    const unreconciled = { ...partialRefund, subtotalAmount: 12 };
    const noTaxSplit = { ...partialRefund, subtotalAmount: 12, taxAmount: 0 };
    for (const refund of [unreconciled, noTaxSplit]) {
      const s = projectProductProfitability(source({ sales: [sale({ refunds: [refund] })] }), NOW).saleAttempts[0]!;
      expect(s.issueCodes).toContain("REFUND_CALCULATION_INCOMPLETE");
      expect(s.knownProfit).toBeNull();
    }
  });

  it("pending refunds and open returns are visible blockers", () => {
    const s = projectProductProfitability(source({ sales: [sale({ refunds: [{ ...partialRefund, status: "pending" }], returns: [{ status: "received", items: [] }] })] }), NOW).saleAttempts[0]!;
    expect(s.issueCodes).toEqual(expect.arrayContaining(["REFUND_PENDING", "RETURN_PENDING"]));
    expect(s.returnState).toBe("pending");
  });

  it("full reversal is NOT zeroed: restored item cost returns to inventory, incurred shipping and fees remain a loss", () => {
    const fullRefund = { status: "succeeded", currency: "EUR", subtotalAmount: 100, shippingAmount: 10, taxAmount: 22, totalAmount: 132, marketplaceFeeAdjustment: null, paymentFeeAdjustment: null };
    const s = projectProductProfitability(
      source({ sales: [sale({ refunds: [fullRefund], returns: [{ status: "completed", items: [{ orderItemId: "oi-1", stockDisposition: "return_to_stock", quantityCompleted: 1 }] }], fullReversal: true })] }),
      NOW,
    ).saleAttempts[0]!;
    expect(s.fullReversal).toBe(true);
    expect(s.restoredToStockQuantity).toBe(1);
    expect(s.costCharged).toBe(0);
    // revenue fully refunded (110 ex-VAT), 5 outbound shipping and 3 payment fee remain incurred
    expect(s.knownProfit).toBe(-8);
    expect(s.recorded.profit).toBe(53);
  });

  it("a returned item NOT restored to stock keeps its cost charged to the attempt", () => {
    const fullRefund = { status: "succeeded", currency: "EUR", subtotalAmount: 100, shippingAmount: 10, taxAmount: 22, totalAmount: 132, marketplaceFeeAdjustment: null, paymentFeeAdjustment: null };
    const s = projectProductProfitability(source({ sales: [sale({ refunds: [fullRefund], returns: [{ status: "completed", items: [{ orderItemId: "oi-1", stockDisposition: "damaged", quantityCompleted: 1 }] }] })] }), NOW).saleAttempts[0]!;
    expect(s.costCharged).toBe(52);
    expect(s.knownProfit).toBe(-60);
  });

  it("full reversal without return evidence -> REVERSAL_COST_RECOVERY_INCOMPLETE", () => {
    const s = projectProductProfitability(source({ sales: [sale({ fullReversal: true })] }), NOW).saleAttempts[0]!;
    expect(s.issueCodes).toContain("REVERSAL_COST_RECOVERY_INCOMPLETE");
  });

  it("multi-item order: order-level amounts are not attributed to this product -> ORDER_LEVEL_COST_ALLOCATION_INCOMPLETE", () => {
    const lines = [{ orderItemId: "oi-1", productId: "p-1", quantity: 1 }, { orderItemId: "oi-2", productId: "p-2", quantity: 1 }];
    const s = projectProductProfitability(source({ sales: [sale({ lines })] }), NOW).saleAttempts[0]!;
    expect(s.amountScope).toBe("order");
    expect(s.issueCodes).toContain("ORDER_LEVEL_COST_ALLOCATION_INCOMPLETE");
    expect(s.knownProfit).toBeNull();
    expect(s.profitBeforeUnknownCosts).toBeNull();
  });
});

describe("Phase 1B product profitability - SQLite read path", () => {
  function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
  const t = "2026-03-01T00:00:00.000Z";
  const TABLES = ["products", "purchases", "purchase_lines", "purchase_allocations", "purchase_receipts", "purchase_receipt_lines", "orders", "order_items", "sale_financials", "payments", "shipments", "refunds", "return_requests", "return_items", "sale_reversals", "finance_entries", "stock_movements"];

  it("loads canonical rows read-only and projects them; no table is mutated", () => {
    const { sqlite, db } = memoryDb();
    db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Brass clock", slug: "brass-clock", type: "unique_item", status: "sold", stockQuantity: 0, purchaseCost: 40, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
    db.insert(schema.purchases).values({ id: "pu-1", sourceType: "Auction", currency: "EUR", itemSubtotal: 40, totalCost: 52, status: "Received", orderedAt: "2026-01-05T00:00:00.000Z", receivedAt: "2026-01-20T00:00:00.000Z" }).run();
    db.insert(schema.purchaseLines).values({ id: "pl-1", purchaseId: "pu-1", productId: "p-1", titleSnapshot: "Brass clock", quantity: 1, receivedQuantity: 1, unitPurchaseCost: 40 }).run();
    db.insert(schema.purchaseAllocations).values({ id: "pa-1", purchaseId: "pu-1", purchaseLineId: "pl-1", productId: "p-1", allocationMethod: "Equal", allocatedBuyerPremium: 5, allocatedShippingCost: 3, allocatedTaxVat: 2, allocatedPackagingCost: 1, allocatedMiscCost: 1, allocatedCustomsCost: 0, allocatedTotalCost: 52 }).run();
    db.insert(schema.purchaseReceipts).values({ id: "pr-1", purchaseId: "pu-1", idempotencyKey: "rcpt-1", receivedAt: "2026-01-15T00:00:00.000Z" }).run();
    db.insert(schema.purchaseReceiptLines).values({ id: "prl-1", receiptId: "pr-1", purchaseLineId: "pl-1", quantityReceived: 1 }).run();
    db.insert(schema.orders).values({ id: "o-1", orderNumber: "N-1", orderDraftId: "draft-1", guestEmail: "a@example.invalid", status: "completed", paymentStatus: "paid", subtotalAmount: 110, shippingAmount: 10, totalAmount: 132, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: t, updatedAt: t }).run();
    db.insert(schema.orderItems).values({ id: "oi-1", orderId: "o-1", productId: "p-1", productSku: "SKU-1", productTitle: "Brass clock", productSlug: "brass-clock", productType: "unique_item", quantity: 1, unitPrice: 110, totalPrice: 110, currency: "EUR" }).run();
    db.insert(schema.saleFinancials).values({ id: "sf-1", orderId: "o-1", grossRevenue: 132, shippingCharged: 10, shippingCost: 5, taxVat: 22, itemCost: 40, netRevenue: 105, profit: 65, currency: "EUR", sourceSnapshot: "{}", completedAt: "2026-03-10T00:00:00.000Z" }).run();
    db.insert(schema.payments).values({ id: "pay-1", orderId: "o-1", provider: "cash_on_delivery", status: "paid", amount: 132, currency: "EUR", idempotencyKey: "pay-1" }).run();
    db.insert(schema.shipments).values({ id: "sh-1", orderId: "o-1", carrierCode: "other", status: "delivered", shippingCost: 5, currency: "EUR" }).run();

    const dump = () => Object.fromEntries(TABLES.map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = dump();
    const r = getProductProfitability(db, "p-1", NOW);
    expect(dump()).toEqual(before);

    expect(r).toMatchObject({ productId: "p-1", sku: "SKU-1", acquisitionDate: "2026-01-15T00:00:00.000Z", acquisitionDateSource: "purchase_receipt", inventoryAgeDays: null });
    expect(r.cost).toMatchObject({ costBasisSource: "purchase_allocation", authoritativeLandedCost: 52, productPurchaseCost: 40, conflictCodes: ["COST_BASIS_CONFLICT"] });
    const s = r.saleAttempts[0]!;
    expect(s).toMatchObject({ orderId: "o-1", amountScope: "item", saleChannel: "Internal", grossRevenue: 132, cashCollected: 132, outboundShippingCost: 5, knownNetRevenue: 105, costCharged: 52, knownProfit: null, profitBeforeUnknownCosts: 53, profitStatus: "INCOMPLETE" });
    expect(s.marketplaceFee.status).toBe("not_applicable");
    expect(s.issueCodes).toContain("UNKNOWN_PAYMENT_FEE");
    expect(s.recorded.profit).toBe(65);
  });

  it("unknown product -> NotFoundError", () => {
    const { db } = memoryDb();
    expect(() => getProductProfitability(db, "missing", NOW)).toThrow("Product not found");
  });
});
