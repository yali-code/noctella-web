import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runInventoryServiceMigrationAudit } from "../src/scripts/inventoryServiceMigrationAudit";

describe("Sprint 31A-I4 route-wired inventory service migration",()=>{
  const stock=fs.readFileSync(path.resolve(__dirname,"../src/services/stockMovements.ts"),"utf8");
  const erp=fs.readFileSync(path.resolve(__dirname,"../src/services/erpInventoryBridge.ts"),"utf8");
  const ctx=fs.readFileSync(path.resolve(__dirname,"../src/services/inventoryApplicationContextForDb.ts"),"utf8");
  test("stock movements route-wired service passes migration audit",()=>expect(runInventoryServiceMigrationAudit().ok).toBe(true));
  for(const name of ["createGetInventoryUseCase","createSetInventoryQuantityUseCase","createDecreaseInventoryUseCase","createIncreaseInventoryUseCase","createListStockMovementsUseCase","createListProductsUseCase"]){ test(`stock movement service delegates to ${name}`,()=>expect(stock).toContain(name)); }
  for(const bad of ["createStockMovementRepositoryBundleForDb","new SqliteUnitOfWork","db.select","db.insert","db.update","db.transaction","sql`","randomUUID()","Date.now()"]){ test(`stock movement service avoids ${bad}`,()=>expect(stock).not.toContain(bad)); }
  for(const name of ["listStockMovements","getCurrentStockBalance","createManualStockAdjustment","applyStockMovement"]){ test(`public API remains exported: ${name}`,()=>expect(stock).toContain(`export async function ${name}`)); }
  test("ERP stock adjustment uses route-wired migrated stock service",()=>expect(erp).toContain("await applyStockMovement(db"));
  test("ERP stock adjustment no longer opens service transaction",()=>expect(erp).not.toContain("db.transaction((tx:any)=> applyStockMovementSync"));
  test("InventoryApplicationContext construction is isolated outside route-wired service",()=>expect(ctx).toContain("buildInventoryApplicationContext"));
  for(let i=1;i<=28;i++) test(`migration invariant ${i}`,()=>{ expect(stock).toContain("InventoryApplicationContext"); expect(stock).toContain("context(dbOrContext)"); });
});
