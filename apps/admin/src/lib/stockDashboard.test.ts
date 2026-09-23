import { afterEach, describe, expect, it, vi } from "vitest";
import type { StockMovement } from "@noctella/shared";
import { api } from "./api";
import { allPages, allStockMovements, filterStockRows, loadStockDashboard, openingStockMovement, stockPeriodBounds, stockSummary, type StockRow } from "./stockDashboard";

afterEach(() => vi.restoreAllMocks());
const movement = (id: string, date: Date, extra = {}): StockMovement => ({ id: `m-${id}`, productId: id, createdAt: date.toISOString(), type: "manual_adjustment", stockBefore: 1, quantityDelta: 1, stockAfter: 1, idempotencyKey: `product-create-stock:${id}`, ...extra } as StockMovement);
const row = (id: string, opening?: StockMovement, extra = {}): StockRow => ({ product: { id, stockQuantity: 1, updatedAt: "2099-01-01", ...extra } as StockRow["product"], opening });

describe("stock reporting arithmetic and local calendar dates", () => {
  const now = new Date(2026, 0, 15, 12);
  it("recognizes the historical malformed opening by stable identity, not arithmetic", () => {
    const initial = movement("p", new Date(2026, 0, 1));
    expect(openingStockMovement("p", [movement("p", new Date(2025, 11, 1), { idempotencyKey: "adjustment", stockBefore: 0 }), initial])).toBe(initial);
    expect(openingStockMovement("p", [movement("p", now, { idempotencyKey: null, note: "Product creation stock quantity" })])).toBeDefined();
    expect(openingStockMovement("p", [movement("p", now, { idempotencyKey: null, stockBefore: 0 })])).toBeUndefined();
  });
  const rows = [
    row("old", movement("old", new Date(2025, 10, 30, 23, 59, 59))),
    row("dec", movement("dec", new Date(2025, 11, 1))),
    row("dec-end", movement("dec-end", new Date(2025, 11, 31, 23, 59, 59, 999))),
    row("jan", movement("jan", new Date(2026, 0, 1))),
    row("jan-end", movement("jan-end", new Date(2026, 0, 31, 23, 59, 59, 999))),
    row("feb", movement("feb", new Date(2026, 1, 1))), row("missing"),
  ];
  it("This Month uses opening createdAt, including local midnight and excluding next month", () => {
    expect(filterStockRows(rows, "this-month", now).map((r) => r.product.id)).toEqual(["jan", "jan-end"]);
  });
  it("Last Month handles year rollover and the entire final day", () => {
    expect(filterStockRows(rows, "last-month", now).map((r) => r.product.id)).toEqual(["dec", "dec-end"]);
  });
  it("custom ranges include both local dates and reject invalid/reversed ranges", () => {
    expect(filterStockRows(rows, "custom", now, "2025-12-31", "2026-01-01").map((r) => r.product.id)).toEqual(["dec-end", "jan"]);
    expect(filterStockRows(rows, "custom", now, "2026-01-02", "2026-01-01")).toEqual([]);
    expect(stockPeriodBounds("custom", now, "2026-02-30", "2026-03-01")).toBeNull();
  });
  it("All keeps products without an opening movement", () => {
    expect(filterStockRows(rows, "all", now)).toEqual(rows);
  });
  it("summary uses recorded unit cost times current stock; unknown costs never become zero", () => {
    const data = [row("a", movement("a", now), { stockQuantity: 3, purchaseCost: 12.34 }), row("b"), row("c", undefined, { purchaseCost: 0, stockQuantity: 2 }), row("d", undefined, { stockQuantity: 0, purchaseCost: 90 })];
    expect(stockSummary(data, now)).toEqual({ products: 4, units: 6, receivedThisMonth: 1, recordedCost: 37.02, excludedCosts: 1 });
    expect(stockSummary([row("missing")], now).recordedCost).toBeNull();
  });
});

describe("complete paginated stock reads", () => {
  it("loads beyond 50 products and 100 movements/categories, with no purchase-history requests", async () => {
    const products = Array.from({ length: 151 }, (_, i) => ({ id: `p${i}`, stockQuantity: 1 }));
    const movements = products.map((p) => movement(p.id, new Date(2026, 0, 1)));
    const categories = Array.from({ length: 105 }, (_, i) => ({ id: `c${i}` }));
    const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
      const url = new URL(path, "http://test.local");
      const source = url.pathname === "/api/products" ? products : url.pathname === "/api/stock-movements" ? movements : categories;
      const page = Number(url.searchParams.get("page") ?? 1);
      // The server is free to cap page size lower than requested.
      const pageSize = 50;
      return { items: source.slice((page - 1) * pageSize, page * pageSize), total: source.length, page, pageSize } as any;
    });
    const result = await loadStockDashboard();
    expect(result.rows).toHaveLength(151);
    expect(result.rows[150].opening?.id).toBe("m-p150");
    expect(result.categories).toHaveLength(105);
    expect(get.mock.calls.some(([path]) => path.includes("purchase-history"))).toBe(false);
    expect(get).toHaveBeenCalledWith("/api/products?page=4&pageSize=100");
  });
  it("exhausts an individual product's movement history for its Stock Card", async () => {
    const movements = Array.from({ length: 101 }, (_, i) => movement("p", new Date(2026, 0, 1), { id: `m${i}` }));
    const get = vi.spyOn(api, "get").mockResolvedValueOnce({ items: movements.slice(0, 100), total: 101, page: 1, pageSize: 100 }).mockResolvedValueOnce({ items: movements.slice(100), total: 101, page: 2, pageSize: 100 });
    expect(await allStockMovements("p")).toHaveLength(101);
    expect(get).toHaveBeenLastCalledWith("/api/stock-movements?pageSize=100&productId=p&page=2");
  });
  it("reports incomplete or changing pagination instead of silently showing partial totals", async () => {
    const read = vi.fn().mockResolvedValueOnce({ items: [{ id: "1" }], page: 1, pageSize: 1, total: 2 }).mockResolvedValueOnce({ items: [], page: 2, pageSize: 1, total: 2 });
    await expect(allPages(read)).rejects.toThrow("pagination is incomplete");
    const repeat = vi.fn().mockImplementation(async (page) => ({ items: [{ id: "1" }], page, pageSize: 1, total: 2 }));
    await expect(allPages(repeat)).rejects.toThrow("changed during loading");
  });
});
