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
  inspectReturnItem,
  receiveReturn,
} from "../src/services/returns";
import { inspectReturnUseCase } from "../src/use-cases/return/useCases";

const at = "2026-09-13T12:00:00.000Z";
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
  await db.insert(schema.products).values([
    { id: "p1", sku: "SKU-177-1", title: "Vase", slug: "vase-177", type: ProductType.LotItem, status: ProductStatus.Published, stockQuantity: 3, priceEur: 100, createdAt: at, updatedAt: at },
    { id: "p2", sku: "SKU-177-2", title: "Lamp", slug: "lamp-177", type: ProductType.LotItem, status: ProductStatus.Published, stockQuantity: 4, priceEur: 80, createdAt: at, updatedAt: at },
  ]);
  await db.insert(schema.orders).values({
    id: "o1", orderNumber: "NOC-177", guestEmail: "buyer@example.com",
    status: OrderStatus.Completed, paymentStatus: PaymentStatus.Paid,
    subtotalAmount: 360, shippingAmount: 0, taxAmount: 0, totalAmount: 360,
    currency: "EUR", billingAddress: address, shippingAddress: address,
    createdAt: at, updatedAt: at,
  });
  await db.insert(schema.orderItems).values([
    { id: "oi1", orderId: "o1", productId: "p1", productSku: "SKU-177-1", productTitle: "Vase", productSlug: "vase-177", productType: ProductType.LotItem, quantity: 1, unitPrice: 100, totalPrice: 100, currency: "EUR", createdAt: at, updatedAt: at },
    { id: "oi2", orderId: "o1", productId: "p2", productSku: "SKU-177-2", productTitle: "Lamp", productSlug: "lamp-177", productType: ProductType.LotItem, quantity: 1, unitPrice: 80, totalPrice: 80, currency: "EUR", createdAt: at, updatedAt: at },
  ]);
  const ret: any = await createReturnRequest(db, {
    orderId: "o1",
    reason: ReturnReason.Damaged,
    requestedResolution: ReturnResolution.Refund,
    items: [
      { orderItemId: "oi1", quantityRequested: 1 },
      { orderItemId: "oi2", quantityRequested: 1 },
    ],
  });
  await db.update(schema.returnItems)
    .set({ quantityRequested: 2 })
    .where(eq(schema.returnItems.orderItemId, "oi1"));
  await authorizeReturn(db, ret.id, {});
  await receiveReturn(db, ret.id, {});
  return { db, ret };
}

async function requestFor(db: ReturnType<typeof database>, returnId: string) {
  return (await db.select().from(schema.returnRequests)
    .where(eq(schema.returnRequests.id, returnId)))[0];
}

async function itemFor(db: ReturnType<typeof database>, returnId: string, orderItemId: string) {
  return (await db.select().from(schema.returnItems)
    .where(eq(schema.returnItems.returnRequestId, returnId)))
    .find((item) => item.orderItemId === orderItemId)!;
}

async function inspectionEvents(db: ReturnType<typeof database>, returnId: string) {
  return (await db.select().from(schema.returnEvents)
    .where(eq(schema.returnEvents.returnRequestId, returnId)))
    .filter((event) => event.eventType === "item_inspected");
}

describe("Sprint 177 return inspection event idempotency", () => {
  it("accepts unlimited same-item reinspections with one unique versioned event each", async () => {
    const { db, ret } = await fixture();
    const startingVersion = (await requestFor(db, ret.id)).version;
    const inspections = [
      { quantityReceived: 1, condition: ReturnItemCondition.Damaged, stockDisposition: ReturnStockDisposition.NoStockChange, inspectionNote: "first", inspectionResult: { grade: "C" } },
      { quantityReceived: 2, condition: ReturnItemCondition.OriginalCondition, stockDisposition: ReturnStockDisposition.ReturnToStock, inspectionNote: "replacement", inspectionResult: { grade: "A" } },
      { quantityReceived: 2, condition: ReturnItemCondition.OriginalCondition, stockDisposition: ReturnStockDisposition.ReturnToStock, inspectionNote: "replacement", inspectionResult: { grade: "A" } },
      { quantityReceived: 1, condition: ReturnItemCondition.Damaged, stockDisposition: ReturnStockDisposition.Quarantine, inspectionNote: "fourth", inspectionResult: { grade: "D" } },
      { quantityReceived: 2, condition: ReturnItemCondition.OriginalCondition, stockDisposition: ReturnStockDisposition.ReturnToStock, inspectionNote: "final", inspectionResult: { grade: "A+" } },
    ];

    for (const inspection of inspections) {
      await expect(inspectReturnItem(db, ret.id, { orderItemId: "oi1", ...inspection }))
        .resolves.toMatchObject({ status: ReturnStatus.Inspecting });
    }

    const events = await inspectionEvents(db, ret.id);
    expect(events).toHaveLength(inspections.length);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(inspections.length);
    expect(events.every((event) => event.idempotencyKey !== null)).toBe(true);
    for (let index = 0; index < inspections.length; index += 1) {
      const version = startingVersion + index + 1;
      expect(events).toContainEqual(expect.objectContaining({
        idempotencyKey: `item_inspected:${ret.id}:oi1:v${version}`,
        previousStatus: index === 0 ? ReturnStatus.Received : ReturnStatus.Inspecting,
        newStatus: ReturnStatus.Inspecting,
      }));
    }
    expect(await requestFor(db, ret.id)).toMatchObject({ version: startingVersion + inspections.length });
    expect(await itemFor(db, ret.id, "oi1")).toMatchObject({
      quantityReceived: 2,
      condition: ReturnItemCondition.OriginalCondition,
      stockDisposition: ReturnStockDisposition.ReturnToStock,
      inspectionNote: "final",
    });
    expect(JSON.parse((await itemFor(db, ret.id, "oi1")).inspectionResult ?? "null"))
      .toEqual({ grade: "A+", stockDisposition: ReturnStockDisposition.ReturnToStock });
  });

  it("uses the inspected order item and aggregate version for distinct-item event keys", async () => {
    const { db, ret } = await fixture();
    const startingVersion = (await requestFor(db, ret.id)).version;
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", quantityReceived: 2 });
    await inspectReturnItem(db, ret.id, { orderItemId: "oi2", quantityReceived: 1 });
    await inspectReturnItem(db, ret.id, { orderItemId: "oi1", quantityReceived: 1 });

    expect((await inspectionEvents(db, ret.id)).map((event) => event.idempotencyKey).sort())
      .toEqual([
        `item_inspected:${ret.id}:oi1:v${startingVersion + 1}`,
        `item_inspected:${ret.id}:oi1:v${startingVersion + 3}`,
        `item_inspected:${ret.id}:oi2:v${startingVersion + 2}`,
      ].sort());
    expect((await requestFor(db, ret.id)).version).toBe(startingVersion + 3);
  });

  it("rolls back item and return mutations when event persistence fails", async () => {
    const { db, ret } = await fixture();
    const beforeRequest = await requestFor(db, ret.id);
    const beforeItem = await itemFor(db, ret.id, "oi1");
    const duplicateKey = `item_inspected:${ret.id}:oi1:v${beforeRequest.version + 1}`;
    await db.insert(schema.returnEvents).values({
      id: "collision-177", returnRequestId: ret.id, orderId: "o1",
      eventType: "fixture_collision", previousStatus: null, newStatus: null,
      payloadSnapshot: "{}", errorCode: null, errorMessage: null,
      idempotencyKey: duplicateKey, createdAt: at,
    });

    await expect(inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 2,
      condition: ReturnItemCondition.Damaged,
      stockDisposition: ReturnStockDisposition.Quarantine,
      inspectionNote: "must roll back",
    })).rejects.toThrow();

    expect(await requestFor(db, ret.id)).toEqual(beforeRequest);
    expect(await itemFor(db, ret.id, "oi1")).toEqual(beforeItem);
    expect(await inspectionEvents(db, ret.id)).toHaveLength(0);
  });

  it("fails before event append when the inspection-state update returns null", async () => {
    const append = vi.fn();
    const current = { id: "r1", orderId: "o1", status: ReturnStatus.Received, version: 4 };
    const repositories: any = {
      returnRepositories: {
        returns: { read: { getById: () => current }, write: { updateInspectionState: () => null } },
        items: {
          read: { listByReturn: () => [{ id: "ri1", orderItemId: "oi1", quantityRequested: 1 }] },
          write: { updateReceivedQuantity: vi.fn(), updateInspectionResult: vi.fn() },
        },
        events: { write: { append } },
      },
    };
    const context: any = { unitOfWork: { run: (work: any) => work({ repositories }) }, ports: {} };

    await expect(inspectReturnUseCase(context, "r1", { orderItemId: "oi1" }))
      .rejects.toThrow("Return was updated by another transaction");
    expect(append).not.toHaveBeenCalled();
  });

  it("defers inventory effects until completion and completes from final inspection state", async () => {
    const { db, ret } = await fixture();
    await inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 1,
      stockDisposition: ReturnStockDisposition.NoStockChange,
    });
    await inspectReturnItem(db, ret.id, {
      orderItemId: "oi1", quantityReceived: 2,
      stockDisposition: ReturnStockDisposition.ReturnToStock,
    });
    expect(await db.select().from(schema.stockMovements)).toHaveLength(0);
    expect(await db.select().from(schema.backgroundJobs)).toHaveLength(0);
    expect((await db.select().from(schema.products).where(eq(schema.products.id, "p1")))[0].stockQuantity).toBe(3);

    await approveReturn(db, ret.id, {});
    await completeReturn(db, ret.id);

    expect(await itemFor(db, ret.id, "oi1")).toMatchObject({ quantityCompleted: 2 });
    expect((await db.select().from(schema.products).where(eq(schema.products.id, "p1")))[0].stockQuantity).toBe(5);
    expect((await db.select().from(schema.stockMovements))
      .filter((movement) => movement.type === StockMovementType.ReturnIn || movement.type === "return_in"))
      .toHaveLength(1);
  });
});
