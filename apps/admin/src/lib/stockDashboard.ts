import type { StockMovement } from "@noctella/shared";
import { api } from "./api";
import { listStockMovements, listStockProducts } from "./stock";
import type { Category, PaginatedResult, ProductListItem } from "./types";

/** Exhaust the existing read endpoints; never present a partial page as a total. */
export async function allPages<T extends { id: string }>(read: (page: number) => Promise<PaginatedResult<T>>): Promise<T[]> {
  const items: T[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const result = await read(page);
    total ??= result.total;
    if (result.page !== page || result.total !== total || !Number.isInteger(total) || total < 0 ||
        (!result.items.length && items.length < total)) {
      throw new Error("Stock data changed or pagination is incomplete. Please reload.");
    }
    for (const item of result.items) {
      if (ids.has(item.id)) throw new Error("Stock data changed during loading. Please reload.");
      ids.add(item.id);
      items.push(item);
    }
    if (items.length > total) throw new Error("Stock pagination is inconsistent. Please reload.");
    if (items.length === total) return items;
  }
}

export const allStockMovements = (productId?: string) => allPages((page) => listStockMovements(productId, page));
export const allStockCategories = () => allPages((page) => api.get<PaginatedResult<Category>>(`/api/categories?page=${page}&pageSize=100`));

export function openingStockMovement(productId: string, movements: StockMovement[]): StockMovement | undefined {
  const ordered = movements.filter((m) => m.productId === productId).slice().sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  // The stable identity also recognizes historical entries with incorrect before/after arithmetic.
  return ordered.find((m) => m.idempotencyKey === `product-create-stock:${productId}`) ??
    ordered.find((m) => m.type === "manual_adjustment" && m.note === "Product creation stock quantity");
}

export interface StockRow { product: ProductListItem; opening?: StockMovement }
export async function loadStockDashboard(): Promise<{ rows: StockRow[]; categories: Category[] }> {
  const [products, movements, categories] = await Promise.all([
    allPages((page) => listStockProducts(page, 100)), allStockMovements(), allStockCategories(),
  ]);
  const byProduct = new Map<string, StockMovement[]>();
  for (const movement of movements) {
    const group = byProduct.get(movement.productId) ?? [];
    group.push(movement);
    byProduct.set(movement.productId, group);
  }
  return { categories, rows: products.map((product) => ({ product, opening: openingStockMovement(product.id, byProduct.get(product.id) ?? []) })) };
}

export type StockPeriod = "this-month" | "last-month" | "all" | "custom";
function localDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
export function stockPeriodBounds(period: StockPeriod, now = new Date(), start = "", end = ""): [Date, Date] | null {
  if (period === "all") return null;
  if (period === "custom") {
    const from = localDay(start), through = localDay(end);
    if (!from || !through || from > through) return null;
    return [from, new Date(through.getFullYear(), through.getMonth(), through.getDate() + 1)];
  }
  const month = now.getMonth() - (period === "last-month" ? 1 : 0);
  return [new Date(now.getFullYear(), month, 1), new Date(now.getFullYear(), month + 1, 1)];
}
export function filterStockRows(rows: StockRow[], period: StockPeriod, now = new Date(), start = "", end = "") {
  if (period === "all") return rows;
  const bounds = stockPeriodBounds(period, now, start, end);
  if (!bounds) return [];
  return rows.filter(({ opening }) => {
    const time = opening ? Date.parse(opening.createdAt) : NaN;
    return time >= bounds[0].getTime() && time < bounds[1].getTime();
  });
}
export function stockSummary(rows: StockRow[], now = new Date()) {
  const inStock = rows.filter(({ product }) => product.stockQuantity > 0);
  const recorded = inStock.filter(({ product: p }) => p.purchaseCost != null && Number.isFinite(p.purchaseCost) && p.purchaseCost >= 0 && (!p.purchaseCurrency || p.purchaseCurrency === "EUR"));
  return {
    products: rows.length,
    units: rows.reduce((sum, { product }) => sum + product.stockQuantity, 0),
    receivedThisMonth: filterStockRows(rows, "this-month", now).length,
    recordedCost: recorded.length ? recorded.reduce((sum, { product }) => sum + Math.round(product.purchaseCost! * 100) * product.stockQuantity, 0) / 100 : null,
    excludedCosts: inStock.length - recorded.length,
  };
}
export function stockDate(value?: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "—";
}
