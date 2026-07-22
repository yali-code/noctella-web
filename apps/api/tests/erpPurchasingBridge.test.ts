import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { ensureSchema } from "../src/db/migrate";
import { BadRequestError, ConflictError } from "../src/services/errors";
import { createSupplier, createPurchase, allocatePurchaseCosts, receivePurchase, getPurchaseLandedCostSummary, executeSupplierCommand, executePurchaseCommand, findSupplierCandidates } from "../src/services/erpPurchasingBridge";
import { LandedCostAllocationMethod, ProductStatus, ProductType, StockMovementType, SupplierType } from "@noctella/shared";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import * as schema from "../src/db/schema";
import { stockMovements, erpCommandExecutions, purchaseReceipts, purchases, purchaseLines, purchaseAllocations, purchaseEvents, suppliers } from "../src/db/schema";

function memoryDb() { const sqlite = new Database(":memory:"); sqlite.pragma("foreign_keys = ON"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
function commandChecksum(payload: any) { return createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex"); }

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
    const receiptMovements = (await db.select().from(stockMovements)).filter((movement) => movement.type === StockMovementType.PurchaseReceipt);
    expect(receiptMovements).toHaveLength(1);
    await executePurchaseCommand(db,"client",env({ lines:[{purchaseLineId:purchase.lines[0].id, quantityReceived:1},{purchaseLineId:purchase.lines[1].id, quantityReceived:1}] },"r1"),"ReceivePurchase",purchase.id);
    expect(await db.select().from(purchaseReceipts)).toHaveLength(1);
    expect((await db.select().from(stockMovements)).filter((movement) => movement.type === StockMovementType.PurchaseReceipt)).toHaveLength(1);
    expect((await getPurchaseLandedCostSummary(db,purchase.id)).complete).toBe(true);
  });
});

describe("purchasing command idempotency and transaction hardening (Sprint 48B)", () => {
  async function seedProduct(d: any, catName: string, sku: string) {
    const categoryId = (await createCategory(d, { name: catName, displayOrder: 0, isActive: true })).id;
    return createProduct(d, { sku, title: `Lot ${sku}`, slug: sku.toLowerCase(), type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, stockQuantity: 0, priceEur: 100, purchaseCurrency: "EUR" } as any);
  }

  it("A: a successful command reaches Completed; replay does not re-execute", async () => {
    const { db: d } = memoryDb();
    const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, idempotencyKey: key, payload });
    await executeSupplierCommand(d, "client", env({ name: "Sprint48 Supplier" }, "a1"));
    const [row]: any = await d.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "a1"));
    expect(row.status).toBe("Completed");
    expect(row.completedAt).toBeTruthy();
    expect(row.safeErrorCode).toBeNull();
    const replay: any = await executeSupplierCommand(d, "client", env({ name: "Sprint48 Supplier" }, "a1"));
    expect(replay.status).toBe("Completed");
    expect(await d.select().from(suppliers)).toHaveLength(1);
  });

  it("B: an ordinary validation failure marks the command Failed with a safe error code; original error propagates", async () => {
    const { db: d } = memoryDb();
    const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, idempotencyKey: key, payload });
    await expect(executePurchaseCommand(d, "client", env({ lines: [] }, "b1"), "CreatePurchase")).rejects.toBeInstanceOf(BadRequestError);
    const [row]: any = await d.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "b1"));
    expect(row.status).toBe("Failed");
    expect(row.completedAt).toBeTruthy();
    expect(row.safeErrorCode).toBe("BadRequestError");
  });

  it("C: retrying the same key and payload after Failed executes again, reuses the same row, and can reach Completed", async () => {
    const { db: d } = memoryDb();
    const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, idempotencyKey: key, payload });
    const payload = { name: "Retry Supplier", countryCode: "BE" };
    const t = new Date().toISOString();
    await d.insert(suppliers).values({ id: "blocker-c", erpReferenceId: null, name: "Retry Supplier", normalizedName: "retry supplier", supplierType: SupplierType.Dealer, countryCode: "BE", city: null, email: null, phone: null, website: null, taxNumber: null, notes: null, status: "Active", createdAt: t, updatedAt: t });
    await expect(executeSupplierCommand(d, "client", env(payload, "c1"))).rejects.toBeInstanceOf(ConflictError);
    const failedRows: any = await d.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "c1"));
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe("Failed");
    await d.delete(suppliers).where(eq(suppliers.id, "blocker-c"));
    const retried: any = await executeSupplierCommand(d, "client", env(payload, "c1"));
    expect(retried.normalizedName).toBe("retry supplier");
    const completedRows: any = await d.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "c1"));
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0].id).toBe(failedRows[0].id);
    expect(completedRows[0].status).toBe("Completed");
  });

  it("D: a Failed row still enforces checksum matching — a different payload throws ConflictError without executing", async () => {
    const { db: d } = memoryDb();
    const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, idempotencyKey: key, payload });
    const t = new Date().toISOString();
    await d.insert(suppliers).values({ id: "blocker-d", erpReferenceId: null, name: "Blocked Supplier", normalizedName: "blocked supplier", supplierType: SupplierType.Dealer, countryCode: "BE", city: null, email: null, phone: null, website: null, taxNumber: null, notes: null, status: "Active", createdAt: t, updatedAt: t });
    await expect(executeSupplierCommand(d, "client", env({ name: "Blocked Supplier", countryCode: "BE" }, "d1"))).rejects.toBeInstanceOf(ConflictError);
    await d.delete(suppliers).where(eq(suppliers.id, "blocker-d"));
    await expect(executeSupplierCommand(d, "client", env({ name: "Different Supplier", countryCode: "BE" }, "d1"))).rejects.toBeInstanceOf(ConflictError);
    expect(await d.select().from(suppliers).where(eq(suppliers.normalizedName, "different supplier"))).toHaveLength(0);
  });

  it("E: a recent Accepted row with a matching checksum throws ConflictError and performs no business writes", async () => {
    const { db: d } = memoryDb();
    const payload = { name: "Blocked By Accepted" };
    await d.insert(erpCommandExecutions).values({ id: "row-e", clientId: "client", commandId: "e1", requestId: null, idempotencyKey: "e1", commandType: "CreateSupplier", entityType: "Supplier", entityId: null, status: "Accepted", requestChecksum: commandChecksum(payload), createdAt: new Date().toISOString() });
    await expect(executeSupplierCommand(d, "client", { commandId: "e1", idempotencyKey: "e1", payload })).rejects.toThrow("ERP command is already in progress");
    expect(await d.select().from(suppliers)).toHaveLength(0);
  });

  it("F: a stale Accepted row (older than 60s) with a matching checksum is reused, createdAt refreshed, no duplicate row", async () => {
    const { db: d } = memoryDb();
    const payload = { name: "Stale Recovery Supplier" };
    const staleCreatedAt = new Date(Date.now() - 61_000).toISOString();
    await d.insert(erpCommandExecutions).values({ id: "row-f", clientId: "client", commandId: "f1", requestId: null, idempotencyKey: "f1", commandType: "CreateSupplier", entityType: "Supplier", entityId: null, status: "Accepted", requestChecksum: commandChecksum(payload), createdAt: staleCreatedAt });
    const result: any = await executeSupplierCommand(d, "client", { commandId: "f1", idempotencyKey: "f1", payload });
    expect(result.normalizedName).toBe("stale recovery supplier");
    const rows: any = await d.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "f1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("row-f");
    expect(new Date(rows[0].createdAt).getTime()).toBeGreaterThan(new Date(staleCreatedAt).getTime());
  });

  it("G: ReceivePurchase's outer command reaches Completed; inner receipt/stock-movement idempotency is unchanged", async () => {
    const { db: d } = memoryDb();
    const product = await seedProduct(d, "Cat G", "PG1");
    const supplier: any = await createSupplier(d, { name: "Dealer G", supplierType: SupplierType.Dealer });
    const purchase: any = await createPurchase(d, { supplierId: supplier.id, sourceType: "Auction", lines: [{ productId: product.id, titleSnapshot: "Lot G", quantity: 2, unitPurchaseCost: 20 }] });
    const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, idempotencyKey: key, payload });
    await executePurchaseCommand(d, "client", env({ lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] }, "g1"), "ReceivePurchase", purchase.id);
    const [row]: any = await d.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "g1"));
    expect(row.status).toBe("Completed");
    await executePurchaseCommand(d, "client", env({ lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] }, "g1"), "ReceivePurchase", purchase.id);
    expect(await d.select().from(purchaseReceipts)).toHaveLength(1);
    expect((await d.select().from(stockMovements)).filter((m: any) => m.type === StockMovementType.PurchaseReceipt)).toHaveLength(1);
  });

  it("H: a failure partway through purchaseLines insertion rolls back the purchase row and all lines — no event remains", async () => {
    const { sqlite, db: d } = memoryDb();
    const product = await seedProduct(d, "Cat H", "PH1");
    sqlite.exec("CREATE TRIGGER block_second_line BEFORE INSERT ON purchase_lines WHEN NEW.title_snapshot = 'FAIL-TRIGGER' BEGIN SELECT RAISE(ABORT, 'simulated failure during line insert'); END;");
    try {
      await expect(createPurchase(d, { sourceType: "Other", lines: [{ productId: product.id, titleSnapshot: "OK line", quantity: 1, unitPurchaseCost: 10 }, { titleSnapshot: "FAIL-TRIGGER", quantity: 1, unitPurchaseCost: 5 }] })).rejects.toThrow();
    } finally {
      sqlite.exec("DROP TRIGGER block_second_line");
    }
    expect(await d.select().from(purchases)).toHaveLength(0);
    expect(await d.select().from(purchaseLines)).toHaveLength(0);
    expect(await d.select().from(purchaseEvents)).toHaveLength(0);
  });

  it("I: a failure during the event insert rolls back the purchase row and all lines", async () => {
    const { sqlite, db: d } = memoryDb();
    const product = await seedProduct(d, "Cat I", "PI1");
    sqlite.exec("ALTER TABLE purchase_events RENAME TO purchase_events_disabled");
    try {
      await expect(createPurchase(d, { sourceType: "Other", lines: [{ productId: product.id, titleSnapshot: "Lot I", quantity: 1, unitPurchaseCost: 10 }] })).rejects.toThrow();
    } finally {
      sqlite.exec("ALTER TABLE purchase_events_disabled RENAME TO purchase_events");
    }
    expect(await d.select().from(purchases)).toHaveLength(0);
    expect(await d.select().from(purchaseLines)).toHaveLength(0);
  });

  it("J: a failure after deleting existing allocations but before new inserts complete restores the original allocation set exactly", async () => {
    const { sqlite, db: d } = memoryDb();
    const product = await seedProduct(d, "Cat J", "PJ1");
    const purchase: any = await createPurchase(d, { sourceType: "Other", shippingCost: 10, lines: [{ productId: product.id, titleSnapshot: "Lot J", quantity: 2, unitPurchaseCost: 20 }] });
    await allocatePurchaseCosts(d, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const before: any = await d.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId, purchase.id));
    expect(before.length).toBeGreaterThan(0);
    sqlite.exec("CREATE TRIGGER block_allocation_insert BEFORE INSERT ON purchase_allocations BEGIN SELECT RAISE(ABORT, 'simulated failure during allocation replacement'); END;");
    try {
      await expect(allocatePurchaseCosts(d, purchase.id, { allocationMethod: LandedCostAllocationMethod.ByQuantity })).rejects.toThrow();
    } finally {
      sqlite.exec("DROP TRIGGER block_allocation_insert");
    }
    const after: any = await d.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId, purchase.id));
    expect(after).toEqual(before);
  });

  it("K: a failure after some new allocation inserts have already run still restores the original allocation set exactly", async () => {
    const { sqlite, db: d } = memoryDb();
    const categoryId = (await createCategory(d, { name: "Cat K", displayOrder: 0, isActive: true })).id;
    const productOk = await createProduct(d, { sku: "PK1", title: "OK", slug: "pk1", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, stockQuantity: 0, priceEur: 100, purchaseCurrency: "EUR" } as any);
    const productFail = await createProduct(d, { sku: "PK2", title: "Fail", slug: "pk2", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId, stockQuantity: 0, priceEur: 100, purchaseCurrency: "EUR" } as any);
    const purchase: any = await createPurchase(d, { sourceType: "Other", shippingCost: 10, lines: [{ productId: productOk.id, titleSnapshot: "OK", quantity: 1, unitPurchaseCost: 10 }, { productId: productFail.id, titleSnapshot: "Fail", quantity: 1, unitPurchaseCost: 10 }] });
    await allocatePurchaseCosts(d, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    const before: any = await d.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId, purchase.id));
    sqlite.exec(`CREATE TRIGGER block_specific_allocation BEFORE INSERT ON purchase_allocations WHEN NEW.product_id = '${productFail.id}' BEGIN SELECT RAISE(ABORT, 'simulated failure partway through allocation replacement'); END;`);
    try {
      await expect(allocatePurchaseCosts(d, purchase.id, { allocationMethod: LandedCostAllocationMethod.ByQuantity })).rejects.toThrow();
    } finally {
      sqlite.exec("DROP TRIGGER block_specific_allocation");
    }
    const after: any = await d.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId, purchase.id));
    expect(after).toEqual(before);
  });

  it("L: a successful allocation replacement still produces the expected complete set with unchanged calculations", async () => {
    const { db: d } = memoryDb();
    const product = await seedProduct(d, "Cat L", "PL1");
    const purchase: any = await createPurchase(d, { sourceType: "Other", shippingCost: 10, customsCost: 2, packagingCost: 1, buyerPremium: 5, taxVat: 3, miscellaneousCost: 4, lines: [{ productId: product.id, titleSnapshot: "Lot L", quantity: 2, unitPurchaseCost: 20 }] });
    const summary: any = await allocatePurchaseCosts(d, purchase.id, { allocationMethod: LandedCostAllocationMethod.ByItemCost });
    expect(summary.reconciled).toBe(true);
    expect(summary.complete).toBe(true);
  });
});
