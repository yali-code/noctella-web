import { createHash } from "node:crypto";
import { ProductStatus, ProductType } from "@noctella/shared";
import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { createCategory } from "../src/services/categories";
import { BadRequestError, ConflictError } from "../src/services/errors";
import { executeCreateProduct, executeStockAdjustment, executeUpdateProduct, workspace, labelData } from "../src/services/erpInventoryBridge";
import { erpCommandExecutions, productErpMetadata, products, stockMovements } from "../src/db/schema";

function commandChecksum(commandType: string, entityId: string | undefined, payload: any) { return createHash("sha256").update(JSON.stringify({ commandType, entityId, payload })).digest("hex"); }

describe("ERP inventory bridge", () => {
  let db: ReturnType<typeof createTestDb>; let categoryId = "";
  const env = (commandType:string, payload:any, key="idem-1") => ({ commandId:`cmd-${key}`, requestId:`req-${key}`, commandType, entityType:"Product", idempotencyKey:key, payload, createdAt:new Date().toISOString() });
  beforeEach(async () => { db=createTestDb(); categoryId=(await createCategory(db,{ name:"Workspace", displayOrder:0, isActive:true })).id; });
  it("creates minimal ERP products, preserves identity/metadata and blocks duplicate idempotency drift", async () => {
    const out:any = await executeCreateProduct(db,"env",env("CreateProduct",{ sku:"ERP18-1", title:"ERP Bridge", categoryId, priceEur:100, erpReferenceId:"erp-18", noctellaId:"N-18", barcodeValue:"BC18", shippingCostEur:5, packagingCostEur:2, miscCostsEur:3, depthValue:4, diameterValue:6 }));
    expect(out.status).toBe("Succeeded");
    expect((await db.select().from(stockMovements)).length).toBe(1);
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
    expect((await db.select().from(stockMovements)).length).toBe(2);
    const dup:any = await executeStockAdjustment(db,"env",created.productId,env("AdjustStock",{ quantityDelta:5, reason:"opening stock" }, "stock-1"));
    expect(dup.metadata?.movementId ?? dup.movementId).toBe(stock.movementId);
    await expect(executeStockAdjustment(db,"env",created.productId,env("AdjustStock",{ quantityDelta:0, reason:"zero" }, "stock-zero"))).rejects.toThrow(/Non-zero/);
    const w:any = await workspace(db, created.productId); expect(w.landedCost).toMatchObject({ landedCost:26, complete:true, expectedGrossProfit:24 }); expect(w.landedCost.expectedRoi).toBeCloseTo(24/26); expect(w.physicalStock).toBe(5); expect(w.availableStock).toBe(5);
    const l:any = await labelData(db, created.productId); expect(l).toMatchObject({ sku:"ERP18-2", barcodeValue:"LBL", priceEur:50 });
    expect(JSON.stringify(await db.select().from(erpCommandExecutions))).not.toMatch(/opening stock.*quantityDelta/);
  });
});

describe("inventory command idempotency lifecycle (Sprint 49B)", () => {
  let db: ReturnType<typeof createTestDb>; let categoryId = "";
  const env = (commandType: string, payload: any, key = "idem-1") => ({ commandId: `cmd-${key}`, requestId: `req-${key}`, commandType, entityType: "Product", idempotencyKey: key, payload, createdAt: new Date().toISOString() });
  beforeEach(async () => { db = createTestDb(); categoryId = (await createCategory(db, { name: "Lifecycle", displayOrder: 0, isActive: true })).id; });

  it("A: a successful command reaches Succeeded; replay returns stored result without re-executing", async () => {
    const created: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "A1", title: "A Product", categoryId, priceEur: 50 }, "a1"));
    expect(created.status).toBe("Succeeded");
    const [row]: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "a1"));
    expect(row.status).toBe("Succeeded");
    expect(row.completedAt).toBeTruthy();
    expect(row.safeErrorCode).toBeNull();
    const replay: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "A1", title: "A Product", categoryId, priceEur: 50 }, "a1"));
    expect(replay.status).toBe("Succeeded");
    expect(await db.select().from(products)).toHaveLength(1);
  });

  it("B: an ordinary validation failure marks the command Failed with a safe error code; original error propagates", async () => {
    await expect(executeCreateProduct(db, "env", env("CreateProduct", { title: "Missing SKU", categoryId, priceEur: 50 }, "b1"))).rejects.toBeInstanceOf(BadRequestError);
    const [row]: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "b1"));
    expect(row.status).toBe("Failed");
    expect(row.completedAt).toBeTruthy();
    expect(row.safeErrorCode).toBe("BadRequestError");
  });

  it("C: retrying the same key and payload after Failed executes again, reuses the same row, and can reach Succeeded", async () => {
    const blocker: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "BLOCK1", title: "Blocker", categoryId, priceEur: 10, erpReferenceId: "dup-ref-c" }, "blocker-c"));
    const payload = { sku: "C1", title: "Retry Product", categoryId, priceEur: 20, erpReferenceId: "dup-ref-c" };
    await expect(executeCreateProduct(db, "env", env("CreateProduct", payload, "c1"))).rejects.toBeInstanceOf(ConflictError);
    const failedRows: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "c1"));
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe("Failed");
    await db.update(products).set({ erpReferenceId: null }).where(eq(products.id, blocker.productId));
    const retried: any = await executeCreateProduct(db, "env", env("CreateProduct", payload, "c1"));
    expect(retried.status).toBe("Succeeded");
    const completedRows: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "c1"));
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0].id).toBe(failedRows[0].id);
    expect(completedRows[0].status).toBe("Succeeded");
  });

  it("D: a Failed row still enforces checksum matching — a different payload throws ConflictError, no execution, row not reset", async () => {
    const blocker: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "BLOCK2", title: "Blocker2", categoryId, priceEur: 10, erpReferenceId: "dup-ref-d" }, "blocker-d"));
    const payload = { sku: "D1", title: "D Product", categoryId, priceEur: 20, erpReferenceId: "dup-ref-d" };
    await expect(executeCreateProduct(db, "env", env("CreateProduct", payload, "d1"))).rejects.toBeInstanceOf(ConflictError);
    const failedRows: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "d1"));
    expect(failedRows[0].status).toBe("Failed");
    await db.update(products).set({ erpReferenceId: null }).where(eq(products.id, blocker.productId));
    const differentPayload = { sku: "D2", title: "Different", categoryId, priceEur: 99 };
    await expect(executeCreateProduct(db, "env", env("CreateProduct", differentPayload, "d1"))).rejects.toBeInstanceOf(ConflictError);
    const rowsAfter: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "d1"));
    expect(rowsAfter[0].status).toBe("Failed");
    expect(await db.select().from(products).where(eq(products.sku, "D2"))).toHaveLength(0);
  });

  it("E: a recent Accepted row with a matching checksum throws ConflictError and performs no business writes", async () => {
    const payload = { sku: "E1", title: "E Product", categoryId, priceEur: 30 };
    const sum = commandChecksum("CreateProduct", undefined, payload);
    await db.insert(erpCommandExecutions).values({ id: "row-e", clientId: "env", commandId: "cmd-e1", requestId: null, idempotencyKey: "e1", commandType: "CreateProduct", entityType: "Product", entityId: null, status: "Accepted", requestChecksum: sum, createdAt: new Date().toISOString() });
    await expect(executeCreateProduct(db, "env", env("CreateProduct", payload, "e1"))).rejects.toThrow("ERP command is already in progress");
    expect(await db.select().from(products).where(eq(products.sku, "E1"))).toHaveLength(0);
  });

  it("F: a stale Accepted row (older than 60s) with a matching checksum is reused, createdAt refreshed, no duplicate row", async () => {
    const payload = { sku: "F1", title: "F Product", categoryId, priceEur: 40 };
    const sum = commandChecksum("CreateProduct", undefined, payload);
    const staleCreatedAt = new Date(Date.now() - 61_000).toISOString();
    await db.insert(erpCommandExecutions).values({ id: "row-f", clientId: "env", commandId: "cmd-f1", requestId: null, idempotencyKey: "f1", commandType: "CreateProduct", entityType: "Product", entityId: null, status: "Accepted", requestChecksum: sum, createdAt: staleCreatedAt });
    const result: any = await executeCreateProduct(db, "env", env("CreateProduct", payload, "f1"));
    expect(result.status).toBe("Succeeded");
    const rows: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "f1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("row-f");
    expect(new Date(rows[0].createdAt).getTime()).toBeGreaterThan(new Date(staleCreatedAt).getTime());
  });

  it("G: CreateProduct replay returns the stored result and does not create a second product", async () => {
    await executeCreateProduct(db, "env", env("CreateProduct", { sku: "G1", title: "G Product", categoryId, priceEur: 60 }, "g1"));
    const replay: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "G1", title: "G Product", categoryId, priceEur: 60 }, "g1"));
    expect(replay.status).toBe("Succeeded");
    expect(await db.select().from(products).where(eq(products.sku, "G1"))).toHaveLength(1);
  });

  it("H: UpdateProduct replay does not reapply or duplicate side effects", async () => {
    const created: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "H1", title: "Before", categoryId, priceEur: 70 }, "h-create"));
    const row = (await db.select().from(products).where(eq(products.id, created.productId)))[0];
    const upd1: any = await executeUpdateProduct(db, "env", created.productId, env("UpdateProduct", { expectedUpdatedAt: row.updatedAt, title: "After" }, "h1"));
    expect(upd1.status).toBe("Succeeded");
    const upd2: any = await executeUpdateProduct(db, "env", created.productId, env("UpdateProduct", { expectedUpdatedAt: row.updatedAt, title: "After" }, "h1"));
    expect(upd2.status).toBe("Succeeded");
    expect(upd2.metadata.updatedFields).toEqual(upd1.updatedFields);
    const finalRow = (await db.select().from(products).where(eq(products.id, created.productId)))[0];
    expect(finalRow.title).toBe("After");
  });

  it("I: StockAdjustment replay is idempotent — same movementId, no duplicate movement, quantity changes once", async () => {
    const created: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "I1", title: "I Product", categoryId, priceEur: 80 }, "i-create"));
    const baseline = (await db.select().from(stockMovements)).filter((m: any) => m.productId === created.productId).length;
    const first: any = await executeStockAdjustment(db, "env", created.productId, env("AdjustStock", { quantityDelta: 3, reason: "initial" }, "i1"));
    expect(first.status).toBe("Succeeded");
    const [row]: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "i1"));
    expect(row.status).toBe("Succeeded");
    const replay: any = await executeStockAdjustment(db, "env", created.productId, env("AdjustStock", { quantityDelta: 3, reason: "initial" }, "i1"));
    expect(replay.metadata?.movementId ?? replay.movementId).toBe(first.movementId);
    expect((await db.select().from(stockMovements)).filter((m: any) => m.productId === created.productId).length - baseline).toBe(1);
    const finalProduct = (await db.select().from(products).where(eq(products.id, created.productId)))[0];
    expect(finalProduct.stockQuantity).toBe(3);
  });

  it("J: a StockAdjustment validation failure marks the command Failed and creates no stock movement or quantity change", async () => {
    const created: any = await executeCreateProduct(db, "env", env("CreateProduct", { sku: "J1", title: "J Product", categoryId, priceEur: 90 }, "j-create"));
    const baseline = (await db.select().from(stockMovements)).filter((m: any) => m.productId === created.productId).length;
    await expect(executeStockAdjustment(db, "env", created.productId, env("AdjustStock", { quantityDelta: 0, reason: "zero" }, "j1"))).rejects.toBeInstanceOf(BadRequestError);
    const [row]: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "j1"));
    expect(row.status).toBe("Failed");
    expect(row.safeErrorCode).toBe("BadRequestError");
    expect((await db.select().from(stockMovements)).filter((m: any) => m.productId === created.productId).length - baseline).toBe(0);
    const finalProduct = (await db.select().from(products).where(eq(products.id, created.productId)))[0];
    expect(finalProduct.stockQuantity).toBe(0);
  });

  it("K: two concurrent first calls with the same new idempotency key do not surface a raw SQLite error", async () => {
    const payload = { sku: "K1", title: "K Product", categoryId, priceEur: 15 };
    const results = await Promise.allSettled([
      executeCreateProduct(db, "env", env("CreateProduct", payload, "k1")),
      executeCreateProduct(db, "env", env("CreateProduct", payload, "k1")),
    ]);
    for (const r of results) {
      if (r.status === "rejected") expect(String((r.reason as any)?.message ?? r.reason)).not.toMatch(/UNIQUE constraint/i);
    }
    expect(await db.select().from(products).where(eq(products.sku, "K1"))).toHaveLength(1);
    const rows: any = await db.select().from(erpCommandExecutions).where(eq(erpCommandExecutions.idempotencyKey, "k1"));
    expect(rows).toHaveLength(1);
  });
});
