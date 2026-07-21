import type { DbClient } from "../db/client";
import { createGetInventoryUseCase, createListStockMovementsUseCase, InventoryNotInitializedError } from "../application/inventory";
import { createInventoryApplicationContextForDb } from "./inventoryApplicationContextForDb";
export type StockReconciliationStatus = "Match" | "Mismatch";
export interface StockReconciliationResult { productId: string; projectedQuantity: number; ledgerQuantity: number; status: StockReconciliationStatus }
export async function reconcileProductStock(db: DbClient, productId: string): Promise<StockReconciliationResult | undefined> {
  const ctx = createInventoryApplicationContextForDb(db);
  let inventory;
  try {
    inventory = await createGetInventoryUseCase(ctx).execute({ productId });
  } catch (e) {
    if (e instanceof InventoryNotInitializedError) return undefined;
    throw e;
  }
  const movements = await createListStockMovementsUseCase(ctx).execute({ productId });
  const ledgerQuantity = movements.reduce((sum, m) => sum + m.quantityDelta, 0);
  return { productId, projectedQuantity: inventory.quantity, ledgerQuantity, status: inventory.quantity === ledgerQuantity ? "Match" : "Mismatch" };
}
export async function reconcileStock(db: DbClient, productIds: string[], strict = false) { const results = (await Promise.all(productIds.map((id) => reconcileProductStock(db, id)))).filter((r): r is StockReconciliationResult => Boolean(r)); const mismatches = results.filter((r) => r.status === "Mismatch"); if (strict && mismatches.length) throw new Error("STOCK_RECONCILIATION_MISMATCH"); return { status: mismatches.length ? "Mismatch" as const : "Match" as const, results }; }
