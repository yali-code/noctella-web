// @vitest-environment node
process.env.DATABASE_URL = ":memory:";
process.env.ADMIN_APP_ORIGIN = "http://localhost:3001";
process.env.STOREFRONT_APP_ORIGIN = "http://localhost:3000";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { AdminRole } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getCatalogueProfitability, getProductProfitability, getProductProfitabilityInsights } from "../src/services/productProfitability";
import { catalogueProfitabilityQuerySchema, type CatalogueProfitabilityQuery } from "../src/use-cases/analytics/catalogueProfitability";

/**
 * Analytics Phase 1D: catalogue-wide, read-only profitability + insight view. The catalogue
 * reuses the unchanged Phase 1B projection and Phase 1C insights; these tests compare against
 * the per-product services rather than re-deriving any amount.
 */

const NOW = new Date("2026-10-01T00:00:00.000Z");
const t = "2026-03-01T00:00:00.000Z";
const TABLES = ["products", "categories", "purchases", "purchase_lines", "purchase_allocations", "orders", "order_items", "sale_financials", "payments", "shipments", "refunds", "return_requests", "return_items", "sale_reversals", "finance_entries", "stock_movements"];

function product(db: any, n: number, values: { status: string; stockQuantity: number; purchaseCost: number | null; createdAt?: string; categoryId?: string }) {
  db.insert(schema.products).values({ id: `p-${n}`, sku: `SKU-${n}`, title: `Item ${n}`, slug: `item-${n}`, type: "unique_item", purchaseCurrency: "EUR", updatedAt: t, createdAt: values.createdAt ?? t, ...values }).run();
}

function completedSale(db: any, n: number, f: { grossRevenue: number; taxVat: number; shippingCost: number; paymentFee: number | null; purchaseCost: number }) {
  const orderId = `o-${n}`;
  db.insert(schema.orders).values({ id: orderId, orderNumber: `N-${n}`, orderDraftId: `draft-${n}`, guestEmail: "a@example.invalid", status: "completed", paymentStatus: "paid", subtotalAmount: f.grossRevenue, totalAmount: f.grossRevenue, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: t, updatedAt: t }).run();
  db.insert(schema.orderItems).values({ id: `oi-${n}`, orderId, productId: `p-${n}`, productSku: `SKU-${n}`, productTitle: `Item ${n}`, productSlug: `item-${n}`, productType: "unique_item", quantity: 1, unitPrice: f.grossRevenue, totalPrice: f.grossRevenue, currency: "EUR" }).run();
  const net = f.grossRevenue - f.taxVat - f.shippingCost;
  db.insert(schema.saleFinancials).values({ id: `sf-${n}`, orderId, grossRevenue: f.grossRevenue, shippingCharged: 0, shippingCost: f.shippingCost, paymentFee: f.paymentFee, taxVat: f.taxVat, itemCost: f.purchaseCost, netRevenue: net, profit: net - f.purchaseCost, currency: "EUR", sourceSnapshot: "{}", completedAt: "2026-03-10T00:00:00.000Z" }).run();
  db.insert(schema.payments).values({ id: `pay-${n}`, orderId, provider: "cash_on_delivery", status: "paid", amount: f.grossRevenue, currency: "EUR", idempotencyKey: `pay-${n}` }).run();
  db.insert(schema.shipments).values({ id: `sh-${n}`, orderId, carrierCode: "other", status: "delivered", shippingCost: f.shippingCost, currency: "EUR" }).run();
}

/**
 * p-1 sold, allocation 52 vs purchase_cost 40 (conflict), payment fee unknown -> INCOMPLETE
 * p-2 unsold, no cost, age 30 -> NOT_SOLD + COST_BASIS_MISSING
 * p-3 unsold, cost 30, age 273 -> NOT_SOLD, no insights
 * p-4 sold, all known -> PROVISIONAL, knownProfit 63, roi 157.5
 * p-5 sold at a loss, all known -> PROVISIONAL, knownProfit -57, NEGATIVE_PROFIT
 */
function seedCatalogue(db: any) {
  db.insert(schema.categories).values({ id: "cat-1", name: "Clocks", slug: "clocks" }).run();
  product(db, 1, { status: "sold", stockQuantity: 0, purchaseCost: 40, categoryId: "cat-1" });
  db.insert(schema.purchases).values({ id: "pu-1", sourceType: "Auction", currency: "EUR", itemSubtotal: 40, totalCost: 52, status: "Received" }).run();
  db.insert(schema.purchaseLines).values({ id: "pl-1", purchaseId: "pu-1", productId: "p-1", titleSnapshot: "Item 1", quantity: 1, receivedQuantity: 1, unitPurchaseCost: 40 }).run();
  db.insert(schema.purchaseAllocations).values({ id: "pa-1", purchaseId: "pu-1", purchaseLineId: "pl-1", productId: "p-1", allocationMethod: "Equal", allocatedTaxVat: 2, allocatedTotalCost: 52 }).run();
  completedSale(db, 1, { grossRevenue: 132, taxVat: 22, shippingCost: 5, paymentFee: null, purchaseCost: 40 });
  product(db, 2, { status: "published", stockQuantity: 1, purchaseCost: null, createdAt: "2026-09-01T00:00:00.000Z" });
  product(db, 3, { status: "published", stockQuantity: 1, purchaseCost: 30, createdAt: "2026-01-01T00:00:00.000Z" });
  product(db, 4, { status: "sold", stockQuantity: 0, purchaseCost: 40 });
  completedSale(db, 4, { grossRevenue: 132, taxVat: 22, shippingCost: 5, paymentFee: 2, purchaseCost: 40 });
  product(db, 5, { status: "sold", stockQuantity: 0, purchaseCost: 100 });
  completedSale(db, 5, { grossRevenue: 60, taxVat: 10, shippingCost: 5, paymentFee: 2, purchaseCost: 100 });
}

const q = (raw: Record<string, unknown> = {}): CatalogueProfitabilityQuery => catalogueProfitabilityQuerySchema.parse(raw);
const ids = (result: ReturnType<typeof getCatalogueProfitability>) => result.items.map((i) => i.productId);

describe("Phase 1D catalogue profitability service", () => {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema }) as any;
  seedCatalogue(db);

  it("evaluates every product and reports deterministic summary counts over the full catalogue", () => {
    const result = getCatalogueProfitability(db, q(), NOW);
    expect(result.summary).toEqual({
      totalProducts: 5,
      sold: 3,
      notSold: 2,
      byProfitStatus: { COMPLETE: 0, PROVISIONAL: 2, INCOMPLETE: 1, NOT_SOLD: 2 },
      productsWithInsight: { COST_BASIS_MISSING: 1, COST_BASIS_CONFLICT: 1, SHIPPING_COST_MISSING: 0, REVENUE_CASH_MISMATCH: 0, NEGATIVE_PROFIT: 1, PROFITABILITY_INCOMPLETE: 1, LOW_MARGIN: 0, HIGH_MARGIN: 1, AGED_INVENTORY: 0 },
    });
    expect(result.meta).toMatchObject({ total: 5, returned: 5, sort: "severity_desc", provisionalPolicy: true, generatedAt: NOW.toISOString() });
  });

  it("reuses the Phase 1B projection and Phase 1C insights unchanged for every product", () => {
    for (const item of getCatalogueProfitability(db, q(), NOW).items) {
      const pp = getProductProfitability(db, item.productId, NOW);
      const latest = pp.saleAttempts.at(-1) ?? null;
      expect(item).toMatchObject({ profitStatus: pp.profitStatus, inventoryAgeDays: pp.inventoryAgeDays, authoritativeLandedCost: pp.cost.authoritativeLandedCost, costBasisSource: pp.cost.costBasisSource });
      expect(item.latestSale?.knownProfit ?? null).toBe(latest?.knownProfit ?? null);
      expect(item.latestSale?.roiPercent ?? null).toBe(latest?.roiPercent ?? null);
      expect(item.insights.map((i) => i.key)).toEqual(getProductProfitabilityInsights(db, item.productId, NOW).map((i) => i.key));
    }
  });

  it("exposes prioritisation fields without inventing values (unknown stays null)", () => {
    const byId = new Map(getCatalogueProfitability(db, q(), NOW).items.map((i) => [i.productId, i]));
    expect(byId.get("p-1")).toMatchObject({ saleState: "sold", profitStatus: "INCOMPLETE", authoritativeLandedCost: 52, conflictCodes: ["COST_BASIS_CONFLICT"], highestSeverity: "warning", category: "Clocks" });
    expect(byId.get("p-1")!.latestSale).toMatchObject({ knownProfit: null, profitBeforeUnknownCosts: 53, roiPercent: null });
    expect(byId.get("p-1")!.issueCodes).toContain("UNKNOWN_PAYMENT_FEE");
    expect(byId.get("p-1")!.policyFlags).toEqual(["REVENUE_POLICY_PROVISIONAL", "VAT_POLICY_PROVISIONAL"]);
    expect(byId.get("p-2")).toMatchObject({ saleState: "not_sold", authoritativeLandedCost: null, inventoryAgeDays: 30, latestSale: null });
    expect(byId.get("p-4")!.latestSale).toMatchObject({ knownProfit: 63, roiPercent: 157.5 });
    expect(byId.get("p-5")!.insights.map((i) => i.code)).toEqual(["NEGATIVE_PROFIT"]);
  });

  it.each([
    [{ profitStatus: "NOT_SOLD" }, ["p-2", "p-3"]],
    [{ saleState: "sold" }, ["p-5", "p-1", "p-4"]],
    [{ productStatus: "published" }, ["p-2", "p-3"]],
    [{ issueCode: "UNKNOWN_PAYMENT_FEE" }, ["p-1"]],
    [{ issueCode: "COST_BASIS_CONFLICT" }, ["p-1"]],
    [{ insightCode: "NEGATIVE_PROFIT" }, ["p-5"]],
    [{ insightKey: "COST_BASIS_MISSING:product:p-2" }, ["p-2"]],
    [{ category: "Clocks" }, ["p-1"]],
  ])("filter %j", (filter, expected) => {
    const result = getCatalogueProfitability(db, q(filter), NOW);
    expect(ids(result)).toEqual(expected);
    expect(result.meta.filters).toEqual(Object.fromEntries(Object.entries(filter).map(([k, v]) => [k, String(v)])));
    expect(result.summary.totalProducts).toBe(5);
  });

  it.each([
    ["severity_desc", ["p-5", "p-1", "p-2", "p-4", "p-3"]],
    ["known_profit_asc", ["p-5", "p-4", "p-1", "p-2", "p-3"]],
    ["known_profit_desc", ["p-4", "p-5", "p-1", "p-2", "p-3"]],
    ["roi_asc", ["p-5", "p-4", "p-1", "p-2", "p-3"]],
    ["roi_desc", ["p-4", "p-5", "p-1", "p-2", "p-3"]],
    ["inventory_age_desc", ["p-3", "p-2", "p-1", "p-4", "p-5"]],
  ])("sort %s keeps unknown values last in both directions", (sort, expected) => {
    expect(ids(getCatalogueProfitability(db, q({ sort }), NOW))).toEqual(expected);
  });

  it("paginates after filtering/sorting; total reflects the filtered set", () => {
    const result = getCatalogueProfitability(db, q({ sort: "known_profit_asc", limit: "2", offset: "1" }), NOW);
    expect(ids(result)).toEqual(["p-4", "p-1"]);
    expect(result.meta).toMatchObject({ total: 5, returned: 2, limit: 2, offset: 1 });
  });

  it("rejects unknown query fields and invalid enum values", () => {
    expect(() => q({ sort: "price" })).toThrow();
    expect(() => q({ profitStatus: "DONE" })).toThrow();
    expect(() => q({ write: "1" })).toThrow();
  });

  it("is read-only: no table changes after a catalogue evaluation", () => {
    const dump = () => Object.fromEntries(TABLES.map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = dump();
    getCatalogueProfitability(db, q(), NOW);
    expect(dump()).toEqual(before);
  });
});

describe("Phase 1D read API - GET /api/analytics/profitability", () => {
  let app: import("express").Express;
  let db: any;
  let ownerCookie = "";
  let editorCookie = "";

  async function login(role: AdminRole) {
    const { createAdminUser } = await import("../src/services/adminAuth");
    await createAdminUser(db, { email: `${role}@example.com`, password: "Correct-Horse-9!", role });
    const res = await request(app).post("/api/auth/login").send({ email: `${role}@example.com`, password: "Correct-Horse-9!" });
    const cookie = res.headers["set-cookie"];
    return String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0]!;
  }

  beforeAll(async () => {
    app = (await import("../src/app")).default as any;
    db = (await import("../src/db/client")).db;
    seedCatalogue(db);
    ownerCookie = await login(AdminRole.Owner);
    editorCookie = await login(AdminRole.ProductEditor);
  }, 60_000);

  it("returns { summary, items, meta } for analytics.view and changes no data", async () => {
    const dump = () => Object.fromEntries(TABLES.map((table) => [table, db.all(sql.raw(`SELECT * FROM ${table} ORDER BY rowid`))]));
    const before = dump();
    const res = await request(app).get("/api/analytics/profitability?insightCode=NEGATIVE_PROFIT").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["items", "meta", "summary"]);
    expect(res.body.items.map((i: any) => i.productId)).toEqual(["p-5"]);
    expect(res.body.summary.totalProducts).toBe(5);
    expect(res.body.meta).toMatchObject({ total: 1, provisionalPolicy: true, filters: { insightCode: "NEGATIVE_PROFIT" } });
    expect(dump()).toEqual(before);
  });

  it("validates the query (400), requires analytics.view (403), and exposes no mutation endpoint", async () => {
    expect((await request(app).get("/api/analytics/profitability?sort=price").set("Cookie", ownerCookie)).status).toBe(400);
    expect((await request(app).get("/api/analytics/profitability").set("Cookie", editorCookie)).status).toBe(403);
    expect((await request(app).get("/api/analytics/profitability")).status).toBe(401);
    for (const method of ["post", "put", "patch", "delete"] as const) {
      expect((await request(app)[method]("/api/analytics/profitability").set("Cookie", ownerCookie)).status).toBe(404);
    }
  });
});
