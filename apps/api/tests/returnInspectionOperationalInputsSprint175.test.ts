import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  OrderStatus,
  PaymentStatus,
  ProductStatus,
  ProductType,
  ReturnItemCondition,
  ReturnReason,
  ReturnResolution,
  ReturnStatus,
  ReturnStockDisposition,
  StockMovementType,
} from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import {
  approveReturn,
  authorizeReturn,
  completeReturn,
  createReturnRequest,
  getReturnEvents,
  inspectReturnItem,
  receiveReturn,
} from "../src/services/returns";
import { inspectReturnUseCase } from "../src/use-cases/return/useCases";

const at = "2026-09-13T00:00:00.000Z";
const address = JSON.stringify({
  fullName: "Jane",
  line1: "1 Main",
  city: "Paris",
  postalCode: "75001",
  country: "FR",
});

function database() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

async function fixture() {
  const db = database();
  await db.insert(schema.products).values({
    id: "p1", sku: "SKU-175", title: "Vase", slug: "vase-175",
    type: ProductType.LotItem, status: ProductStatus.Published,
    stockQuantity: 3, priceEur: 100, createdAt: at, updatedAt: at,
  });
  await db.insert(schema.orders).values({
    id: "o1", orderNumber: "NOC-175", guestEmail: "buyer@example.com",
    status: OrderStatus.Completed, paymentStatus: PaymentStatus.Paid,
    subtotalAmount: 100, shippingAmount: 0, taxAmount: 0, totalAmount: 100,
    currency: "EUR", billingAddress: address, shippingAddress: address,
    createdAt: at, updatedAt: at,
  });
  await db.insert(schema.orderItems).values({
    id: "oi1", orderId: "o1", productId: "p1", productSku: "SKU-175",
    productTitle: "Vase", productSlug: "vase-175", productType: ProductType.LotItem,
    quantity: 1, unitPrice: 100, totalPrice: 100, currency: "EUR",
    createdAt: at, updatedAt: at,
  });
  const ret: any = await createReturnRequest(db, {
    orderId: "o1", reason: ReturnReason.Damaged,
    requestedResolution: ReturnResolution.Refund,
    items: [{ orderItemId: "oi1", quantityRequested: 1 }],
  });
  await db.update(schema.returnItems)
    .set({ quantityRequested: 2 })
    .where(eq(schema.returnItems.returnRequestId, ret.id));
  await authorizeReturn(db, ret.id, {});
  await receiveReturn(db, ret.id, {});
  return { db, ret };
}

async function itemFor(db: ReturnType<typeof database>, returnId: string) {
  return (await db.select().from(schema.returnItems)
    .where(eq(schema.returnItems.returnRequestId, returnId)))[0];
}

async function mutationSnapshot(db: ReturnType<typeof database>, returnId: string) {
  return {
    request: (await db.select().from(schema.returnRequests)
      .where(eq(schema.returnRequests.id, returnId)))[0],
    item: await itemFor(db, returnId),
    events: await db.select().from(schema.returnEvents),
    movements: await db.select().from(schema.stockMovements),
    jobs: await db.select().from(schema.backgroundJobs),
    product: (await db.select().from(schema.products)
      .where(eq(schema.products.id, "p1")))[0],
  };
}

describe("Sprint 175 return inspection operational inputs", () => {
  it("accepts the full requested quantity", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", quantityReceived: 2 });
    expect(await itemFor(db, ret.id)).toMatchObject({ quantityReceived: 2 });
  });

  it("accepts a partial positive quantity", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", quantityReceived: 1 });
    expect(await itemFor(db, ret.id)).toMatchObject({ quantityReceived: 1 });
  });

  it("defaults an omitted quantity to the requested quantity", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1" });
    expect(await itemFor(db, ret.id)).toMatchObject({ quantityReceived: 2 });
  });

  it.each(Object.values(ReturnItemCondition))("accepts condition %s", async (condition) => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", condition });
    expect(await itemFor(db, ret.id)).toMatchObject({ condition });
  });

  it.each(Object.values(ReturnStockDisposition))("accepts stock disposition %s", async (stockDisposition) => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", stockDisposition });
    expect(await itemFor(db, ret.id)).toMatchObject({ stockDisposition });
  });

  it.each([
    {},
    { condition: null },
    { stockDisposition: null },
    { condition: null, stockDisposition: null },
  ])("accepts omitted and null optional enums %#", async (optional) => {
    const { db, ret } = await fixture();
    await expect(inspectReturnItem(db, ret.id, { orderItemId: "oi1", ...optional }))
      .resolves.toMatchObject({ status: ReturnStatus.Inspecting });
  });

  it("accepts an empty inspection note", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", inspectionNote: "" });
    expect(await itemFor(db, ret.id)).toMatchObject({ inspectionNote: "" });
  });

  it.each([
    [{ damage: "rim", nested: { severity: 2 } }, { damage: "rim", nested: { severity: 2 }, stockDisposition: null }],
    [null, { stockDisposition: null }],
    [["photo-1", "photo-2"], { 0: "photo-1", 1: "photo-2", stockDisposition: null }],
    ["observed", { 0: "o", 1: "b", 2: "s", 3: "e", 4: "r", 5: "v", 6: "e", 7: "d", stockDisposition: null }],
    [7, { stockDisposition: null }],
  ])("accepts inspectionResult shape %# and preserves existing normalization", async (inspectionResult, normalized) => {
    const { db, ret } = await fixture();
    await expect(inspectReturnItem(db, ret.id, { orderItemId: "oi1", inspectionResult }))
      .resolves.toMatchObject({ status: ReturnStatus.Inspecting });
    expect(JSON.parse((await itemFor(db, ret.id)).inspectionResult ?? "null"))
      .toEqual(normalized);
  });

  it("reinspection replaces prior operational values", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 1,
      condition: ReturnItemCondition.Damaged,
      stockDisposition: ReturnStockDisposition.NoStockChange,
      inspectionNote: "first",
    });
    await inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 2,
      condition: ReturnItemCondition.OriginalCondition,
      stockDisposition: ReturnStockDisposition.ReturnToStock,
      inspectionNote: "replacement",
    });
    expect(await itemFor(db, ret.id)).toMatchObject({
      quantityReceived: 2,
      condition: ReturnItemCondition.OriginalCondition,
      stockDisposition: ReturnStockDisposition.ReturnToStock,
      inspectionNote: "replacement",
    });
  });

  it("remains compatible with approval, completion, and inventory restoration", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 2,
      stockDisposition: ReturnStockDisposition.ReturnToStock,
    });
    await approveReturn(db, ret.id, {});
    await completeReturn(db, ret.id);
    expect(await itemFor(db, ret.id)).toMatchObject({ quantityCompleted: 2 });
    const product = (await db.select().from(schema.products)
      .where(eq(schema.products.id, "p1")))[0];
    expect(product.stockQuantity).toBe(5);
    expect((await db.select().from(schema.stockMovements))
      .filter((row) => row.type === StockMovementType.ReturnIn || row.type === "return_in"))
      .toHaveLength(1);
  });

  it.each([
    0, -1, 1.5, "1", "", "abc", null,
    Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ])("rejects invalid quantity %# before opening the unit of work", async (quantityReceived) => {
    const run = vi.fn();
    await expect(inspectReturnUseCase(
      { unitOfWork: { run }, ports: {} as any }, "r1",
      { orderItemId: "oi1", quantityReceived } as any,
    )).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["unknown", ""])("rejects invalid condition %j before the unit of work", async (condition) => {
    const run = vi.fn();
    await expect(inspectReturnUseCase(
      { unitOfWork: { run }, ports: {} as any }, "r1",
      { orderItemId: "oi1", condition } as any,
    )).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["unknown", ""])("rejects invalid disposition %j before the unit of work", async (stockDisposition) => {
    const run = vi.fn();
    await expect(inspectReturnUseCase(
      { unitOfWork: { run }, ports: {} as any }, "r1",
      { orderItemId: "oi1", stockDisposition } as any,
    )).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { orderItemId: "oi1", unknown: true },
    {},
    { orderItemId: "" },
    { orderItemId: null },
  ])("rejects invalid top-level input %# before the unit of work", async (input) => {
    const run = vi.fn();
    await expect(inspectReturnUseCase(
      { unitOfWork: { run }, ports: {} as any }, "r1", input as any,
    )).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects quantity above requested inside the transaction with no mutation", async () => {
    const { db, ret } = await fixture();
    const before = await mutationSnapshot(db, ret.id);
    await expect(inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 3,
    })).rejects.toThrow("Received quantity exceeds requested quantity");
    expect(await mutationSnapshot(db, ret.id)).toEqual(before);
  });

  it("preserves lifecycle and order-item linkage guards", async () => {
    const { db, ret } = await fixture();
    await expect(inspectReturnItem(db, ret.id, { orderItemId: "missing" }))
      .rejects.toThrow("Return item not found");
    await db.update(schema.returnRequests).set({ status: ReturnStatus.Approved })
      .where(eq(schema.returnRequests.id, ret.id));
    await expect(inspectReturnItem(db, ret.id, { orderItemId: "oi1" }))
      .rejects.toThrow("Return must be received before inspection");
  });

  it("records the parsed operational input in the existing event contract", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 1,
      condition: null, stockDisposition: null, inspectionNote: null,
    });
    const events = await getReturnEvents(db, ret.id);
    expect(events.find((entry) => entry.eventType === "item_inspected")?.payloadSnapshot)
      .toMatchObject({ orderItemId: "oi1", quantityReceived: 1 });
  });
});
