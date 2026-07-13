import { api } from "./api";
import type { PaginatedResult, ProductListItem } from "./types";
import type { StockMovement } from "@noctella/shared";

export interface StockAdjustmentInput {
  productId: string;
  quantityDelta: number;
  note?: string;
  createdByAdminUserId?: string;
  idempotencyKey?: string;
}

export async function listStockProducts(page = 1, pageSize = 50): Promise<PaginatedResult<ProductListItem>> {
  return api.get<PaginatedResult<ProductListItem>>(`/api/products?page=${page}&pageSize=${pageSize}`);
}

export async function listStockMovements(productId?: string): Promise<PaginatedResult<StockMovement>> {
  const params = new URLSearchParams({ pageSize: "100" });
  if (productId) params.set("productId", productId);
  return api.get<PaginatedResult<StockMovement>>(`/api/stock-movements?${params.toString()}`);
}

export async function createStockAdjustment(input: StockAdjustmentInput): Promise<StockMovement> {
  return api.post<StockMovement>("/api/stock-movements/adjustments", input);
}
