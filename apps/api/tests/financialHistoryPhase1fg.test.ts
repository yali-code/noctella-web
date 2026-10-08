// @vitest-environment node
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getProductAnalyticsHistory, runProfitabilitySnapshot } from "../src/services/analyticsSnapshots";
import { getCatalogueProfitability } from "../src/services/productProfitability";
import { catalogueProfitabilityQuerySchema } from "../src/use-cases/analytics/catalogueProfitability";
import { productMetricHistoryQuerySchema } from "../src/use-cases/analytics/profitabilitySnapshots";
import { projectProductProfitability, type ProfitabilityPurchaseLineSource, type ProfitabilitySaleSource } from "../src/use-cases/analytics/productProfitability";

/**
 * Analytics Phase 1F (financial completeness) + 1G (point-in-time analytics snapshots).
 */

const NOW = new Date("2026-10-01T15:30:00.000Z");
const DAY = "2026-10-01T00:00:00.000Z";

// ---------------------------------------------------------------- Phase 1F (pure)

function line(id: string, quantity: number, allocatedTotalCost: number): ProfitabilityPurchaseLineSource {
  return { purchaseLineId: id, purchaseId: `pu-${id}`, purchaseStatus: "Received", purchaseCurrency: "EUR", purchaseTotalCost: allocatedTotalCost, quantity, unitPurchaseCost: 40, orderedAt: null, purchaseReceivedAt: null, firstReceiptAt: null, allocation: { allocatedBuyerPremium: 15, allocatedShippingCost: 9, allocatedCustomsCost: null, allocatedPackagingCost: null, allocatedTaxVat: 6, allocatedMiscCost: null, allocatedTotalCost } };
}
const sale = (refunds: ProfitabilitySaleSource["refunds"] = []): ProfitabilitySaleSource => ({
  orderId: "o-1", orderDraftId: "d-1", orderCurrency: "EUR", orderCreatedAt: "2026-03-01T00:00:00.000Z", marketplaceChannel: null, marketplaceOrderedAt: null,
  lines: [{ orderItemId: "oi-1", productId: "p-1", quantity: 1 }],
  saleFinancials: { grossRevenue: 132, shippingCharged: 10, shippingCost: 5, marketplaceFee: null, promotedFee: null, paymentFee: 3, taxVat: 22, itemCost: 52, netRevenue: 105, profit: 53, currency: "EUR", completedAt: "2026-03-10T00:00:00.000Z" },
  payments: [{ status: "paid", amount: 132, currency: "EUR" }], shipments: [{ status: "delivered", shippingCost: 5, currency: "EUR", carrierCode: "dhl" }], refunds, returns: [], fullReversal: false,
});
const project = (purchaseLines: ProfitabilityPurchaseLineSource[], sales: ProfitabilitySaleSource[] = [sale()]) =>
  projectProductProfitability({ product: { id: "p-1", sku: "SKU-1", title: "Item", status: "sold", brand: null, categoryName: null, noctellaId: null, stockQuantity: 0, purchaseCost: 52, purchaseCurrency: "EUR", createdAt: "2026-01-01T00:00:00.000Z" }, purchaseLines, sales }, NOW);

describe("Phase 1F financial completeness", () => {
  it("lot costing: a single allocated quantity-3 line yields per-unit landed cost total / quantity", () => {
    const pp = project([line("pl-1", 3, 156)]);
    expect(pp.cost).toMatchObject({ costBasisSource: "purchase_allocation", allocationLineQuantity: 3, purchaseLineBaseCost: 40, allocationDerivedLandedCost: 52, authoritativeLandedCost: 52, landedCostExInputVat: 50 });
    expect(pp.cost.issueCodes).not.toContain("ALLOCATION_AMBIGUOUS");
    expect(pp.saleAttempts[0]!.knownProfit).toBe(50);
  });

  it("several allocated lines for one product (repeat purchases) remain ALLOCATION_AMBIGUOUS", () => {
    const pp = project([line("pl-1", 1, 52), line("pl-2", 1, 60)]);
    expect(pp.cost.costBasisSource).toBe("product_purchase_cost");
    expect(pp.cost.issueCodes).toContain("ALLOCATION_AMBIGUOUS");
  });

  it("refund fee adjustments are surfaced, never applied, and flagged FEE_ADJUSTMENT_SIGN_UNKNOWN", () => {
    const attempt = project([line("pl-1", 1, 52)], [sale([{ status: "succeeded", currency: "EUR", subtotalAmount: 10, shippingAmount: 0, taxAmount: 2, totalAmount: 12, marketplaceFeeAdjustment: null, paymentFeeAdjustment: 0.4 }])]).saleAttempts[0]!;
    expect(attempt.paymentFeeAdjustment).toBe(0.4);
    expect(attempt.issueCodes).toEqual(expect.arrayContaining(["FEE_ADJUSTMENT_SIGN_UNKNOWN", "REFUND_CALCULATION_INCOMPLETE"]));
    expect(attempt.knownProfit).toBeNull();
  });
});

// ---------------------------------------------------------------- Phase 1G (SQLite)

const OPERATIONAL_TABLES = ["products", "purchases", "purchase_lines", "purchase_allocations", "purchase_receipts", "purchase_receipt_lines", "orders", "order_items", "sale_financials", "payments", "shipments", "refunds", "return_requests", "return_items", "sale_reversals", "finance_entries", "stock_movements"];

function seededDb() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema }) as any;
  const t = "2026-01-01T00:00:00.000Z";
  // p-1: sold, payment fee unknown -> INCOMPLETE, knownProfit null; purchase_cost 40 vs allocation 52 conflict.
  db.insert(schema.products).values({ id: "p-1", sku: "SKU-1", title: "Sold", slug: "sold", type: "unique_item", status: "sold", stockQuantity: 0, purchaseCost: 40, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
  db.insert(schema.purchases).values({ id: "pu-1", sourceType: "Auction", currency: "EUR", itemSubtotal: 40, totalCost: 52, status: "Received" }).run();
  db.insert(schema.purchaseLines).values({ id: "pl-1", purchaseId: "pu-1", productId: "p-1", titleSnapshot: "Sold", quantity: 1, receivedQuantity: 1, unitPurchaseCost: 40 }).run();
  db.insert(schema.purchaseAllocations).values({ id: "pa-1", purchaseId: "pu-1", purchaseLineId: "pl-1", productId: "p-1", allocationMethod: "Equal", allocatedTaxVat: 2, allocatedTotalCost: 52 }).run();
  db.insert(schema.orders).values({ id: "o-1", orderNumber: "N-1", orderDraftId: "d-1", guestEmail: "a@example.invalid", status: "completed", paymentStatus: "paid", subtotalAmount: 132, totalAmount: 132, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: t, updatedAt: t }).run();
  db.insert(schema.orderItems).values({ id: "oi-1", orderId: "o-1", productId: "p-1", productSku: "SKU-1", productTitle: "Sold", productSlug: "sold", productType: "unique_item", quantity: 1, unitPrice: 132, totalPrice: 132, currency: "EUR" }).run();
  db.insert(schema.saleFinancials).values({ id: "sf-1", orderId: "o-1", grossRevenue: 132, shippingCharged: 0, shippingCost: 5, taxVat: 22, itemCost: 40, netRevenue: 105, profit: 65, currency: "EUR", sourceSnapshot: "{}", completedAt: "2026-03-10T00:00:00.000Z" }).run();
  db.insert(schema.payments).values({ id: "pay-1", orderId: "o-1", provider: "cash_on_delivery", status: "paid", amount: 132, currency: "EUR", idempotencyKey: "pay-1" }).run();
  db.insert(schema.shipments).values({ id: "sh-1", orderId: "o-1", carrierCode: "dhl", status: "delivered", shippingCost: 5, currency: "EUR" }).run();
  // p-2: unsold, received 2026-05-01 -> aged (>= 90 days at 2026-10-01).
  db.insert(schema.products).values({ id: "p-2", sku: "SKU-2", title: "Aged", slug: "aged", type: "unique_item", status: "published", stockQuantity: 1, purchaseCost: 30, purchaseCurrency: "EUR", createdAt: t, updatedAt: t }).run();
  db.insert(schema.purchases).values({ id: "pu-2", sourceType: "Auction", currency: "EUR", itemSubtotal: 30, totalCost: 30, status: "Received" }).run();
  db.insert(schema.purchaseLines).values({ id: "pl-2", purchaseId: "pu-2", productId: "p-2", titleSnapshot: "Aged", quantity: 1, receivedQuantity: 1, unitPurchaseCost: 30 }).run();
  db.insert(schema.purchaseReceipts).values({ id: "pr-2", purchaseId: "pu-2", idempotencyKey: "r-2", receivedAt: "2026-05-01T00:00:00.000Z" }).run();
  db.insert(schema.purchaseReceiptLines).values({ id: "prl-2", receiptId: "pr-2", purchaseLineId: "pl-2", quantityReceived: 1 }).run();
  return { sqlite, db };
}
const all = (sqlite: Database.Database, table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as any[];
const metric = (rows: any[], scopeId: string, key: string) => rows.find((r) => r.scope_id === scopeId && r.metric_key === key);

describe("Phase 1G analytics snapshots", () => {
  it("schema DDL is idempotent (ensureSchema re-run on an existing database)", () => {
    const { sqlite } = seededDb();
    expect(() => ensureSchema(sqlite)).not.toThrow();
  });

  it("persists catalogue and product metrics copied from the Phase 1B-1E catalogue, with provenance and distinct observedAt/collectedAt", () => {
    const { sqlite, db } = seededDb();
    const { run, replayed } = runProfitabilitySnapshot(db, { now: NOW, collectedAt: NOW });
    expect(replayed).toBe(false);
    expect(run).toMatchObject({ status: "completed", runType: "profitability_snapshot", sourceType: "internal_deterministic", sourceReference: "noctella.analytics.profitability.v1", observedAt: DAY });
    const rows = all(sqlite, "analytics_metric_snapshots");
    expect(rows).toHaveLength(run.metricCount);
    for (const row of rows) {
      expect(row).toMatchObject({ run_id: run.id, source_type: "internal_deterministic", source_reference: "noctella.analytics.profitability.v1", observed_at: DAY, collected_at: NOW.toISOString() });
    }

    // Catalogue counts equal the Phase 1D summary evaluated at the observation day.
    const catalogue = getCatalogueProfitability(db, catalogueProfitabilityQuerySchema.parse({}), new Date(DAY));
    expect(metric(rows, "catalogue", "product_count").numeric_value).toBe(catalogue.summary.totalProducts);
    expect(metric(rows, "catalogue", "sold_count").numeric_value).toBe(1);
    expect(metric(rows, "catalogue", "unsold_count").numeric_value).toBe(1);
    expect(metric(rows, "catalogue", "status_incomplete_count").numeric_value).toBe(1);
    expect(metric(rows, "catalogue", "status_not_sold_count").numeric_value).toBe(1);
    expect(metric(rows, "catalogue", "products_with_aged_inventory").numeric_value).toBe(catalogue.summary.productsWithInsight.AGED_INVENTORY);
    expect(metric(rows, "catalogue", "products_with_cost_basis_conflict").numeric_value).toBe(1);

    // Product values copied from the catalogue item; unknown stays NULL (never 0).
    const p1 = catalogue.items.find((i) => i.productId === "p-1")!;
    expect(metric(rows, "p-1", "authoritative_landed_cost")).toMatchObject({ numeric_value: p1.authoritativeLandedCost, value_state: "known", unit: "eur" });
    expect(metric(rows, "p-1", "known_profit")).toMatchObject({ numeric_value: null, value_state: "unknown" });
    expect(metric(rows, "p-1", "margin_percent")).toMatchObject({ numeric_value: null, value_state: "unknown" });
    expect(metric(rows, "p-1", "profit_status")).toMatchObject({ text_value: "INCOMPLETE", numeric_value: null });
    expect(metric(rows, "p-1", "inventory_age_days")).toMatchObject({ numeric_value: null, value_state: "not_applicable" });
    expect(metric(rows, "p-1", "cost_basis_conflict")).toMatchObject({ numeric_value: 1, metric_namespace: "insight" });
    expect(metric(rows, "p-2", "inventory_age_days")).toMatchObject({ numeric_value: 153, value_state: "known", unit: "days" });
    expect(metric(rows, "p-2", "aged_inventory").numeric_value).toBe(1);
    expect(metric(rows, "p-2", "known_profit")).toBeUndefined();
  });

  it("a retry for the same day replays the completed run without duplicating snapshots", () => {
    const { sqlite, db } = seededDb();
    const first = runProfitabilitySnapshot(db, { now: NOW, collectedAt: NOW });
    const count = all(sqlite, "analytics_metric_snapshots").length;
    const retry = runProfitabilitySnapshot(db, { now: new Date("2026-10-01T23:59:00.000Z") });
    expect(retry).toMatchObject({ replayed: true, run: { id: first.run.id } });
    expect(all(sqlite, "analytics_metric_snapshots")).toHaveLength(count);
    expect(all(sqlite, "analytics_runs")).toHaveLength(1);
    const nextDay = runProfitabilitySnapshot(db, { now: new Date("2026-10-02T08:00:00.000Z") });
    expect(nextDay.replayed).toBe(false);
    expect(all(sqlite, "analytics_runs")).toHaveLength(2);
  });

  it("never mutates an operational source row", () => {
    const { sqlite, db } = seededDb();
    const dump = () => Object.fromEntries(OPERATIONAL_TABLES.map((t) => [t, all(sqlite, t)]));
    const before = dump();
    runProfitabilitySnapshot(db, { now: NOW, collectedAt: NOW });
    expect(dump()).toEqual(before);
  });

  it("history read returns bounded, filtered, chronological product metrics; unknown product is 404", () => {
    const { db } = seededDb();
    runProfitabilitySnapshot(db, { now: new Date("2026-09-30T10:00:00.000Z") });
    runProfitabilitySnapshot(db, { now: NOW });
    const history = getProductAnalyticsHistory(db, "p-2", productMetricHistoryQuerySchema.parse({ metricKey: "inventory_age_days" }));
    expect(history.items.map((i) => [i.observedAt, i.numericValue])).toEqual([["2026-09-30T00:00:00.000Z", 152], [DAY, 153]]);
    expect(history.items[0]).toMatchObject({ sourceType: "internal_deterministic", unit: "days", metadata: { acquisitionDate: "2026-05-01T00:00:00.000Z" } });
    expect(getProductAnalyticsHistory(db, "p-2", productMetricHistoryQuerySchema.parse({ metricKey: "inventory_age_days", from: DAY })).items).toHaveLength(1);
    expect(getProductAnalyticsHistory(db, "p-2", productMetricHistoryQuerySchema.parse({ limit: "1" })).items).toHaveLength(1);
    expect(() => getProductAnalyticsHistory(db, "missing", productMetricHistoryQuerySchema.parse({}))).toThrow("Product not found");
    expect(() => productMetricHistoryQuerySchema.parse({ from: "yesterday" })).toThrow();
  });
});
