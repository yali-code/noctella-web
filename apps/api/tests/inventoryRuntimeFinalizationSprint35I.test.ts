import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("../src/services/erpPurchasingBridge.ts", import.meta.url), "utf8");
const receivePurchase = source.slice(source.indexOf("export async function receivePurchase"), source.indexOf("export async function getPurchaseEvents"));

describe("Sprint 35I Inventory runtime finalization", () => {
  test("ERP purchase receipt delegates Inventory mutation to the approved Use Case", () => {
    expect(receivePurchase).toContain("increaseInventoryInTransactionUseCase");
    expect(receivePurchase).not.toContain("applyStockMovementSync");
  });

  test("ERP purchase receipt uses transaction-scoped synchronous SQLite Inventory repositories", () => {
    expect(receivePurchase).toContain('createInventoryRepositoryBundleForDb(tx,"sqlite",true)');
    expect(receivePurchase).toContain('result instanceof Promise');
  });

  test("migrated path has no direct Inventory repository write", () => {
    expect(receivePurchase).not.toMatch(/stockMovements\.write\.create|inventoryRepositories\.(inventory|stockMovements)\.(updateWithVersion|append)/);
  });
});
