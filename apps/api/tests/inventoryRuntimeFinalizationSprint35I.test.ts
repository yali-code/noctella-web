import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("../src/services/erpPurchasingBridge.ts", import.meta.url), "utf8");
const receivePurchase = source.slice(source.indexOf("export async function receivePurchase"), source.indexOf("export async function getPurchaseEvents"));
const purchaseUseCases = readFileSync(new URL("../src/application/purchase/useCases.ts", import.meta.url), "utf8");
const purchaseContext = readFileSync(new URL("../src/services/purchaseApplicationContextForDb.ts", import.meta.url), "utf8");

describe("Sprint 35I Inventory runtime finalization", () => {
  test("ERP purchase receipt delegates Inventory mutation to the approved Use Case", () => {
    expect(receivePurchase).toContain("receivePurchaseUseCase");
    expect(purchaseUseCases).toContain("ctx.inventoryReceiptMutation");
    expect(purchaseContext).toContain("increaseInventoryInTransactionUseCase");
    expect(receivePurchase).not.toContain("applyStockMovementSync");
  });

  test("ERP purchase receipt uses transaction-scoped synchronous SQLite Inventory repositories", () => {
    expect(purchaseContext).toContain("createInventoryRepositoryBundleForDb");
    expect(purchaseContext).toContain('driver === "sqlite"');
    expect(purchaseUseCases).toContain("mutation instanceof Promise");
  });

  test("migrated path has no direct Inventory repository write", () => {
    expect(receivePurchase).not.toMatch(/stockMovements\.write\.create|inventoryRepositories\.(inventory|stockMovements)\.(updateWithVersion|append)/);
  });
});
