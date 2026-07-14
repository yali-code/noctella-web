import { ProductStatus, ProductType } from "@noctella/shared";
import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { createCategory } from "../src/services/categories";
import { executeCreateProduct, executeStockAdjustment, executeUpdateProduct, workspace, labelData } from "../src/services/erpInventoryBridge";
import { erpCommandExecutions, productErpMetadata, products, stockMovements } from "../src/db/schema";

describe("ERP inventory bridge", () => {
  let db: ReturnType<typeof createTestDb>; let categoryId = "";
  const env = (commandType:string, payload:any, key="idem-1") => ({ commandId:`cmd-${key}`, requestId:`req-${key}`, commandType, entityType:"Product", idempotencyKey:key, payload, createdAt:new Date().toISOString() });
  beforeEach(async () => { db=createTestDb(); categoryId=(await createCategory(db,{ name:"Workspace", displayOrder:0, isActive:true })).id; });
  it("creates minimal ERP products, preserves identity/metadata and blocks duplicate idempotency drift", async () => {
    const out:any = await executeCreateProduct(db,"env",env("CreateProduct",{ sku:"ERP18-1", title:"ERP Bridge", categoryId, priceEur:100, erpReferenceId:"erp-18", noctellaId:"N-18", barcodeValue:"BC18", shippingCostEur:5, packagingCostEur:2, miscCostsEur:3, depthValue:4, diameterValue:6 }));
    expect(out.status).toBe("Succeeded");
    expect((await db.select().from(stockMovements)).length).toBe(0);
    expect((await db.select().from(products).where(eq(products.id,out.productId)))[0]).toMatchObject({ sku:"ERP18-1", erpReferenceId:"erp-18", stockQuantity:0 });
    expect((await db.select().from(productErpMetadata))[0]).toMatchObject({ noctellaId:"N-18", barcodeValue:"BC18" });
    expect((await executeCreateProduct(db,"env",env("CreateProduct",{ sku:"ERP18-1", title:"ERP Bridge", categoryId, priceEur:100, erpReferenceId:"erp-18", noctellaId:"N-18", barcodeValue:"BC18", shippingCostEur:5, packagingCostEur:2, miscCostsEur:3, depthValue:4, diameterValue:6 }))).status).toBe("Succeeded");
    await expect(executeCreateProduct(db,"env",env("CreateProduct",{ sku:"ERP18-2", title:"Changed", categoryId, priceEur:100 }, "idem-1"))).rejects.toThrow(/different payload/);
  });
  it("updates allowed fields, rejects derived stock, adjusts stock through movements and projects workspace/labels", async () => {
    const created:any = await executeCreateProduct(db,"env",env("CreateProduct",{ sku:"ERP18-2", title:"Before", categoryId, priceEur:50, purchaseCost:20, erpReferenceId:"erp-19" }, "create-2"));
    const row=(await db.select().from(products).where(eq(products.id,created.productId)))[0];
    await expect(executeUpdateProduct(db,"env",created.productId,env("UpdateProduct",{ expectedUpdatedAt:row.updatedAt, stockQuantity:9 }, "upd-bad"))).rejects.toThrow(/cannot update/);
    const upd:any = await executeUpdateProduct(db,"env",created.productId,env("UpdateProduct",{ expectedUpdatedAt:row.updatedAt, title:"After", shippingCostEur:1, packagingCostEur:2, miscCostsEur:3, barcodeValue:"LBL" }, "upd-ok"));
    expect(upd.updatedFields).toEqual(expect.arrayContaining(["title","shippingCostEur","barcodeValue"]));
    const stock:any = await executeStockAdjustment(db,"env",created.productId,env("AdjustStock",{ quantityDelta:5, reason:"opening stock" }, "stock-1"));
    expect(stock).toMatchObject({ previousQuantity:0, delta:5, newQuantity:5 });
    expect((await db.select().from(stockMovements)).length).toBe(1);
    const dup:any = await executeStockAdjustment(db,"env",created.productId,env("AdjustStock",{ quantityDelta:5, reason:"opening stock" }, "stock-1"));
    expect(dup.metadata?.movementId ?? dup.movementId).toBe(stock.movementId);
    await expect(executeStockAdjustment(db,"env",created.productId,env("AdjustStock",{ quantityDelta:0, reason:"zero" }, "stock-zero"))).rejects.toThrow(/Non-zero/);
    const w:any = await workspace(db, created.productId); expect(w.landedCost).toMatchObject({ landedCost:26, complete:true, expectedGrossProfit:24 }); expect(w.landedCost.expectedRoi).toBeCloseTo(24/26);
    const l:any = await labelData(db, created.productId); expect(l).toMatchObject({ sku:"ERP18-2", barcodeValue:"LBL", priceEur:50 });
    expect(JSON.stringify(await db.select().from(erpCommandExecutions))).not.toMatch(/opening stock.*quantityDelta/);
  });
});
