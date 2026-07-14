import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb } from "./testDb";
import { createSupplier, createPurchase, allocatePurchaseCosts, receivePurchase, getPurchaseLandedCostSummary, executeSupplierCommand, executePurchaseCommand, findSupplierCandidates } from "../src/services/erpPurchasingBridge";
import { LandedCostAllocationMethod, ProductStatus, ProductType, SupplierType } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { stockMovements, erpCommandExecutions, purchaseReceipts } from "../src/db/schema";

describe("ERP purchasing bridge", () => {
  let db: ReturnType<typeof createTestDb>; let categoryId = "";
  const env = (payload:any, key="k1") => ({ commandId:`cmd-${key}`, requestId:`req-${key}`, idempotencyKey:key, payload });
  beforeEach(async () => { db=createTestDb(); categoryId=(await createCategory(db,{name:"Purchasing",displayOrder:0,isActive:true})).id; });
  it("creates suppliers safely, detects candidates, and enforces idempotency checksum", async () => {
    const supplier:any = await executeSupplierCommand(db,"client",env({name:" Auction House ", supplierType:SupplierType.AuctionHouse, countryCode:"BE", email:"buyer@example.com"},"s1"));
    expect(supplier.normalizedName).toBe("auction house");
    expect(await findSupplierCandidates(db,"auction house","BE")).toHaveLength(1);
    await expect(createSupplier(db,{name:"Auction House", supplierType:SupplierType.AuctionHouse, countryCode:"BE"})).rejects.toThrow(/candidate/);
    await expect(executeSupplierCommand(db,"client",env({name:"Changed", supplierType:SupplierType.Dealer},"s1"))).rejects.toThrow(/different payload/);
    expect(JSON.stringify(await db.select().from(erpCommandExecutions))).not.toContain("buyer@example.com");
  });
  it("creates auction purchases, allocates landed cost deterministically, receives through stock movements, and replays receipts", async () => {
    const product = await createProduct(db,{ sku:"P19", title:"Lot item", slug:"p19", type:ProductType.UniqueItem, status:ProductStatus.Draft, categoryId, stockQuantity:0, priceEur:100, purchaseCurrency:"EUR" } as any);
    const supplier:any = await createSupplier(db,{name:"Dealer", supplierType:SupplierType.Dealer});
    const purchase:any = await createPurchase(db,{ supplierId:supplier.id, sourceType:"Auction", erpReferenceId:"po-1", invoiceReferenceNumber:"inv-1", auctionHouse:"House", auctionDate:"2026-01-01", shippingCost:10, customsCost:2, packagingCost:1, buyerPremium:5, taxVat:3, miscellaneousCost:4, lines:[{productId:product.id,titleSnapshot:"Lot item",quantity:2,unitPurchaseCost:20,weight:4},{titleSnapshot:"Unlinked",quantity:1,unitPurchaseCost:10,weight:1}] });
    expect(purchase.totalCost).toBe(75);
    const summary:any = await allocatePurchaseCosts(db,purchase.id,{ allocationMethod:LandedCostAllocationMethod.ByItemCost });
    expect(summary.reconciled).toBe(true);
    const receipt:any = await executePurchaseCommand(db,"client",env({ lines:[{purchaseLineId:purchase.lines[0].id, quantityReceived:1},{purchaseLineId:purchase.lines[1].id, quantityReceived:1}] },"r1"),"ReceivePurchase",purchase.id);
    expect(receipt.status).toBe("PartiallyReceived");
    expect(await db.select().from(stockMovements)).toHaveLength(1);
    await executePurchaseCommand(db,"client",env({ lines:[{purchaseLineId:purchase.lines[0].id, quantityReceived:1},{purchaseLineId:purchase.lines[1].id, quantityReceived:1}] },"r1"),"ReceivePurchase",purchase.id);
    expect(await db.select().from(purchaseReceipts)).toHaveLength(1);
    expect((await getPurchaseLandedCostSummary(db,purchase.id)).complete).toBe(true);
  });
});
