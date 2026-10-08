// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getCatalogueProfitability } from "../src/services/productProfitability";
import { catalogueProfitabilityQuerySchema } from "../src/use-cases/analytics/catalogueProfitability";
import { DEFAULT_ANALYTICS_THRESHOLDS, deriveProfitabilityInsights, type AnalyticsInsight, type AnalyticsThresholds } from "../src/use-cases/analytics/profitabilityInsights";
import {
  projectProductProfitability,
  type ProductProfitability,
  type ProductProfitabilitySource,
  type ProfitabilityPurchaseLineSource,
  type ProfitabilitySaleSource,
} from "../src/use-cases/analytics/productProfitability";

/**
 * Analytics Phase 1E: owner-configurable intervention thresholds (LOW_MARGIN, HIGH_MARGIN,
 * AGED_INVENTORY) and the provable-only shipping-zero rule. Fixtures run the real Phase 1B
 * projection; margins/ages are never re-derived here.
 */

const NOW = new Date("2026-10-01T00:00:00.000Z");

function receipt(firstReceiptAt: string): ProfitabilityPurchaseLineSource {
  return { purchaseLineId: "pl-1", purchaseId: "pu-1", purchaseStatus: "Received", purchaseCurrency: "EUR", purchaseTotalCost: 30, quantity: 1, unitPurchaseCost: 30, orderedAt: null, purchaseReceivedAt: null, firstReceiptAt, allocation: null };
}

/** Non-marketplace sale: 132 gross - 22 VAT - 5 shipping = 105 net; payment fee 3; margin base 110. */
function sale(overrides: Partial<ProfitabilitySaleSource> = {}, financials: Partial<ProfitabilitySaleSource["saleFinancials"]> = {}): ProfitabilitySaleSource {
  return {
    orderId: "o-1", orderDraftId: "draft-1", orderCurrency: "EUR", orderCreatedAt: "2026-03-01T00:00:00.000Z", marketplaceChannel: null, marketplaceOrderedAt: null,
    lines: [{ orderItemId: "oi-1", productId: "p-1", quantity: 1 }],
    saleFinancials: { grossRevenue: 132, shippingCharged: 10, shippingCost: 5, marketplaceFee: null, promotedFee: null, paymentFee: 3, taxVat: 22, itemCost: 0, netRevenue: 105, profit: 0, currency: "EUR", completedAt: "2026-03-10T00:00:00.000Z", ...financials },
    payments: [{ status: "paid", amount: 132, currency: "EUR" }],
    shipments: [{ status: "delivered", shippingCost: 5, currency: "EUR", carrierCode: "dhl" }],
    refunds: [], returns: [], fullReversal: false,
    ...overrides,
  };
}

function project(o: { purchaseCost?: number | null; stockQuantity?: number; createdAt?: string; purchaseLines?: ProfitabilityPurchaseLineSource[]; sales?: ProfitabilitySaleSource[] } = {}): ProductProfitability {
  const source: ProductProfitabilitySource = {
    product: { id: "p-1", sku: "SKU-1", title: "Item", status: o.sales?.length === 0 ? "published" : "sold", brand: null, categoryName: null, noctellaId: null, stockQuantity: o.stockQuantity ?? 0, purchaseCost: o.purchaseCost === undefined ? 58 : o.purchaseCost, purchaseCurrency: "EUR", createdAt: o.createdAt ?? "2026-02-01T00:00:00.000Z" },
    purchaseLines: o.purchaseLines ?? [],
    sales: o.sales ?? [sale()],
  };
  return projectProductProfitability(source, NOW);
}

const derive = (pp: ProductProfitability, thresholds?: AnalyticsThresholds) => deriveProfitabilityInsights(pp, NOW, thresholds);
const find = (insights: AnalyticsInsight[], code: string) => insights.find((i) => i.code === code);
const codes = (insights: AnalyticsInsight[]) => insights.map((i) => i.code);

describe("Phase 1E threshold policy", () => {
  it("defaults are explicit analytics policy values", () => {
    expect(DEFAULT_ANALYTICS_THRESHOLDS).toEqual({ lowMarginPercent: 20, highMarginPercent: 40, agedInventoryDays: 90 });
  });
});

describe("Phase 1E margin signals", () => {
  it("LOW_MARGIN fires below the threshold (cost 85 -> knownProfit 17, margin 15.45%)", () => {
    const pp = project({ purchaseCost: 85 });
    expect(pp.saleAttempts[0]!.marginPercent).toBe(15.45);
    const insight = find(derive(pp), "LOW_MARGIN");
    expect(insight).toMatchObject({ key: "LOW_MARGIN:sale_attempt:p-1:o-1", entityType: "sale_attempt", severity: "warning", confidence: "MEDIUM", routingTarget: "PRICING", advisoryOnly: true });
    expect(insight!.evidence).toContainEqual({ fact: "saleAttempts[o-1].marginPercent", value: 15.45 });
    expect(insight!.evidence).toContainEqual({ fact: "threshold.lowMarginPercent", value: 20 });
    expect(codes(derive(pp))).not.toContain("HIGH_MARGIN");
  });

  it("LOW_MARGIN never fires from unknown/incomplete margin, and negative margins stay NEGATIVE_PROFIT only", () => {
    const unknownFee = project({ purchaseCost: 85, sales: [sale({}, { paymentFee: null })] });
    expect(unknownFee.saleAttempts[0]!.marginPercent).toBeNull();
    expect(codes(derive(unknownFee))).not.toContain("LOW_MARGIN");
    const loss = derive(project({ purchaseCost: 150 }));
    expect(codes(loss)).toContain("NEGATIVE_PROFIT");
    expect(codes(loss)).not.toContain("LOW_MARGIN");
  });

  it("HIGH_MARGIN fires exactly at the threshold (cost 58 -> knownProfit 44, margin 40%) and routes to SOURCING", () => {
    const pp = project({ purchaseCost: 58 });
    expect(pp.saleAttempts[0]!.marginPercent).toBe(40);
    expect(find(derive(pp), "HIGH_MARGIN")).toMatchObject({ severity: "info", confidence: "MEDIUM", routingTarget: "SOURCING" });
    expect(codes(derive(project({ purchaseCost: 59 })))).not.toContain("HIGH_MARGIN");
  });

  it("custom injected thresholds replace the defaults", () => {
    const pp = project({ purchaseCost: 58 });
    const custom = derive(pp, { lowMarginPercent: 50, highMarginPercent: 80, agedInventoryDays: 30 });
    expect(codes(custom)).toContain("LOW_MARGIN");
    expect(codes(custom)).not.toContain("HIGH_MARGIN");
  });
});

describe("Phase 1E AGED_INVENTORY", () => {
  const unsold = (firstReceiptAt: string) => project({ stockQuantity: 1, sales: [], purchaseCost: 30, purchaseLines: [receipt(firstReceiptAt)] });

  it("fires at the threshold for in-stock inventory with a purchase-recorded acquisition date", () => {
    const pp = unsold("2026-07-03T00:00:00.000Z");
    expect(pp.inventoryAgeDays).toBe(90);
    const insight = find(derive(pp), "AGED_INVENTORY");
    expect(insight).toMatchObject({ key: "AGED_INVENTORY:product:p-1", entityType: "product", severity: "warning", confidence: "HIGH", routingTarget: "INVENTORY", dataCompleteness: "NOT_SOLD" });
    expect(insight!.evidence).toEqual(expect.arrayContaining([{ fact: "inventoryAgeDays", value: 90 }, { fact: "acquisitionDateSource", value: "purchase_receipt" }, { fact: "threshold.agedInventoryDays", value: 90 }]));
    expect(codes(derive(unsold("2026-07-04T00:00:00.000Z")))).not.toContain("AGED_INVENTORY");
  });

  it("custom agedInventoryDays applies", () => {
    expect(codes(derive(unsold("2026-07-04T00:00:00.000Z"), { ...DEFAULT_ANALYTICS_THRESHOLDS, agedInventoryDays: 30 }))).toContain("AGED_INVENTORY");
  });

  it("a sold product (nothing in stock) never receives AGED_INVENTORY", () => {
    expect(codes(derive(project({ stockQuantity: 0, purchaseLines: [receipt("2025-01-01T00:00:00.000Z")] })))).not.toContain("AGED_INVENTORY");
  });

  it("the product_created fallback is not an acquisition date - no AGED_INVENTORY", () => {
    const pp = project({ stockQuantity: 1, sales: [], purchaseCost: 30, createdAt: "2025-01-01T00:00:00.000Z" });
    expect(pp.acquisitionDateSource).toBe("product_created");
    expect(codes(derive(pp))).not.toContain("AGED_INVENTORY");
  });
});

describe("Phase 1E shipping-zero and payment-fee handling", () => {
  it("a zero shipping cost on a carrier shipment stays unknown and is flagged SHIPPING_COST_ZERO_AMBIGUOUS", () => {
    const pp = project({ sales: [sale({ shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR", carrierCode: "dhl" }] })] });
    const attempt = pp.saleAttempts[0]!;
    expect(attempt.outboundShippingCost).toBeNull();
    expect(attempt.issueCodes).toEqual(expect.arrayContaining(["MISSING_OUTBOUND_SHIPPING", "SHIPPING_COST_ZERO_AMBIGUOUS"]));
    expect(find(derive(pp), "SHIPPING_COST_MISSING")!.evidence).toContainEqual({ fact: "saleAttempts[o-1].issueCode", value: "SHIPPING_COST_ZERO_AMBIGUOUS" });
  });

  it("a zero cost is a proven real zero only for a local-pickup shipment", () => {
    const attempt = project({ sales: [sale({ shipments: [{ status: "delivered", shippingCost: 0, currency: "EUR", carrierCode: "local_pickup" }] })] }).saleAttempts[0]!;
    expect(attempt.outboundShippingCost).toBe(0);
    expect(attempt.issueCodes).not.toContain("MISSING_OUTBOUND_SHIPPING");
    expect(attempt.issueCodes).not.toContain("SHIPPING_COST_ZERO_AMBIGUOUS");
  });

  it("a null payment fee remains UNKNOWN (no provable NOT_APPLICABLE rule)", () => {
    const attempt = project({ sales: [sale({}, { paymentFee: null })] }).saleAttempts[0]!;
    expect(attempt.paymentFee).toEqual({ amount: null, status: "unknown" });
    expect(attempt.issueCodes).toContain("UNKNOWN_PAYMENT_FEE");
  });
});

describe("Phase 1E catalogue exposure", () => {
  it("returns, summarises and filters the new signals; meta exposes thresholds and the payment-fee policy gap", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const db = drizzle(sqlite, { schema }) as any;
    const t = "2026-01-01T00:00:00.000Z";
    db.insert(schema.products).values({ id: "p-aged", sku: "SKU-A", title: "Aged", slug: "aged", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
    db.insert(schema.purchases).values({ id: "pu-1", sourceType: "Auction", currency: "EUR", itemSubtotal: 30, totalCost: 30, status: "Received" }).run();
    db.insert(schema.purchaseLines).values({ id: "pl-1", purchaseId: "pu-1", productId: "p-aged", titleSnapshot: "Aged", quantity: 1, receivedQuantity: 1, unitPurchaseCost: 30 }).run();
    db.insert(schema.purchaseReceipts).values({ id: "pr-1", purchaseId: "pu-1", idempotencyKey: "r-1", receivedAt: "2026-05-01T00:00:00.000Z" }).run();
    db.insert(schema.purchaseReceiptLines).values({ id: "prl-1", receiptId: "pr-1", purchaseLineId: "pl-1", quantityReceived: 1 }).run();
    db.insert(schema.products).values({ id: "p-new", sku: "SKU-B", title: "New", slug: "new", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: t }).run();

    const result = getCatalogueProfitability(db, catalogueProfitabilityQuerySchema.parse({ insightCode: "AGED_INVENTORY" }), NOW);
    expect(result.items.map((i) => i.productId)).toEqual(["p-aged"]);
    expect(result.items[0]!.insights).toContainEqual({ key: "AGED_INVENTORY:product:p-aged", code: "AGED_INVENTORY", severity: "warning", confidence: "HIGH", routingTarget: "INVENTORY" });
    expect(result.summary.productsWithInsight).toMatchObject({ AGED_INVENTORY: 1, LOW_MARGIN: 0, HIGH_MARGIN: 0 });
    expect(result.meta).toMatchObject({ thresholds: DEFAULT_ANALYTICS_THRESHOLDS, policyGaps: ["PAYMENT_FEE_POLICY_INCOMPLETE"] });
    expect(() => catalogueProfitabilityQuerySchema.parse({ insightCode: "HIGH_MARGIN" })).not.toThrow();
    expect(getCatalogueProfitability(db, catalogueProfitabilityQuerySchema.parse({ insightKey: "AGED_INVENTORY:product:p-aged" }), NOW).meta.total).toBe(1);
  });
});
