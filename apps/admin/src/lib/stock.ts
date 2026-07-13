import { StockMovementType, type Product, type StockMovement } from "@noctella/shared";
import { api } from "./api";
import type { PaginatedResult, ProductDetail, ProductListItem } from "./types";

export type StockStateFilter = "" | "in_stock" | "out_of_stock";

export interface StockListItem {
  product: ProductListItem;
  latestMovement?: StockMovement;
}

export interface StockMovementListResponse {
  data: StockMovement[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ManualStockAdjustmentInput {
  productId: string;
  type: StockMovementType.ManualIncrease | StockMovementType.ManualDecrease | StockMovementType.Correction;
  quantity: number;
  unitCost?: number;
  note?: string;
}

export function filterProductsByStockState(items: ProductListItem[], state: StockStateFilter): ProductListItem[] {
  if (state === "in_stock") return items.filter((item) => item.stockQuantity > 0);
  if (state === "out_of_stock") return items.filter((item) => item.stockQuantity === 0);
  return items;
}

export function paginateStockItems<T>(items: T[], page: number, pageSize: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), totalPages };
}

export function latestMovementForProduct(movements: StockMovement[]): StockMovement | undefined {
  return [...movements].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function sortMovementsChronologically(movements: StockMovement[]): StockMovement[] {
  return [...movements].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function listStockProducts(search: string): Promise<ProductListItem[]> {
  const query = new URLSearchParams({ page: "1", pageSize: "100" });
  if (search) query.set("search", search);
  const result = await api.get<PaginatedResult<ProductListItem>>(`/api/products?${query.toString()}`);
  return result.items;
}

export function listStockMovements(params: {
  productId?: string;
  page?: number;
  pageSize?: number;
}): Promise<StockMovementListResponse> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 100),
  });
  if (params.productId) query.set("productId", params.productId);
  return api.get<StockMovementListResponse>(`/api/stock-movements?${query.toString()}`);
}

export async function listStockListItems(search: string, state: StockStateFilter): Promise<StockListItem[]> {
  const products = filterProductsByStockState(await listStockProducts(search), state);
  return Promise.all(
    products.map(async (product) => {
      const movements = await listStockMovements({ productId: product.id, pageSize: 1 });
      return { product, latestMovement: movements.data[0] };
    }),
  );
}

export function getProduct(productId: string): Promise<ProductDetail> {
  return api.get<ProductDetail>(`/api/products/${productId}`);
}

export async function getProductStockHistory(productId: string): Promise<{ product: ProductDetail; movements: StockMovement[] }> {
  const [product, movements] = await Promise.all([
    getProduct(productId),
    listStockMovements({ productId, pageSize: 100 }),
  ]);
  return { product, movements: sortMovementsChronologically(movements.data) };
}

export function createManualStockAdjustment(input: ManualStockAdjustmentInput): Promise<StockMovement> {
  return api.post<StockMovement>("/api/stock-movements", {
    productId: input.productId,
    type: input.type,
    quantity: input.quantity,
    ...(input.type === StockMovementType.Correction ? { newStock: input.quantity } : {}),
    ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
}

export function primaryImageUrl(product: ProductDetail | ProductListItem): string | undefined {
  if ("images" in product) return product.images.find((image) => image.isPrimary)?.url ?? product.images[0]?.url;
  return product.primaryImageUrl;
}

export type { Product, ProductDetail, ProductListItem, StockMovement };
