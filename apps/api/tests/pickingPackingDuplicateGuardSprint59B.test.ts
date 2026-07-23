import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { ConflictError } from "../src/services/errors";
import { createPackingTask, createPickingTask, updatePacking, updatePicking } from "../src/services/erpWarehouseBridge";

/**
 * Sprint 59B: proves the duplicate-task creation gap in createPickingTask/createPackingTask is
 * corrected - a second active task for the same order/picking task is rejected, but a Cancelled
 * prior task never blocks a new one.
 */
describe("picking/packing duplicate-task correction (Sprint 59B)", () => {
  function setup() {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const db = drizzle(sqlite) as any;
    return { sqlite, db };
  }
  function insertOrder(sqlite: Database.Database, orderId: string, itemIds: string[]) {
    const t = new Date().toISOString();
    sqlite.prepare(`INSERT INTO orders (id, order_number, guest_email, status, payment_status, subtotal_amount, shipping_amount, tax_amount, total_amount, currency, billing_address, shipping_address, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderId, `ORD-${orderId}`, "buyer@example.com", "Processing", "Paid", 100, 0, 0, 100, "EUR", "{}", "{}", t, t);
    itemIds.forEach((itemId, i) => {
      const productId = `product-${orderId}-${i}`;
      sqlite.prepare(`INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, price_eur, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(productId, `SKU-${orderId}-${i}`, `Product ${i}`, `product-${orderId}-${i}`, "UniqueItem", "Draft", 1, 50, t, t);
      sqlite.prepare(`INSERT INTO order_items (id, order_id, product_id, product_sku, product_title, product_slug, product_type, quantity, unit_price, total_price, currency, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(itemId, orderId, productId, `SKU-${orderId}-${i}`, `Product ${i}`, `product-${orderId}-${i}`, "UniqueItem", 1, 50, 50, "EUR", t, t);
    });
  }
  const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, requestId: `req-${key}`, commandType: "CreatePickingTask", idempotencyKey: key, payload });

  it("A: a second CreatePickingTask for an order with an active (Pending) picking task is rejected, no row/line/event written", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-a", ["item-a1"]);
    await createPickingTask(db, "env", env({}, "a-first"), "order-a");
    await expect(createPickingTask(db, "env", env({}, "a-second"), "order-a")).rejects.toBeInstanceOf(ConflictError);
    expect(await db.all(sql`SELECT * FROM picking_tasks WHERE order_id='order-a'`)).toHaveLength(1);
    expect(await db.all(sql`SELECT * FROM picking_task_lines`)).toHaveLength(1);
    expect(await db.all(sql`SELECT * FROM warehouse_events WHERE event_type='PickingCreated'`)).toHaveLength(1);
  });

  it("B: a Cancelled picking task does not block a new one for the same order", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-b", ["item-b1"]);
    const first: any = await createPickingTask(db, "env", env({}, "b-first"), "order-b");
    await updatePicking(db, "env", { commandId: "cmd-b-cancel", idempotencyKey: "b-cancel", payload: {} }, first.pickingTaskId, "CancelPickingTask");
    const second: any = await createPickingTask(db, "env", env({}, "b-second"), "order-b");
    expect(second.status).toBe("Succeeded");
    expect(await db.all(sql`SELECT * FROM picking_tasks WHERE order_id='order-b'`)).toHaveLength(2);
  });

  it("C: a second CreatePackingTask for a picking task with an active (Pending) packing task is rejected, no row/line/event written", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-c", ["item-c1"]);
    const pick: any = await createPickingTask(db, "env", env({}, "c-pick"), "order-c");
    await db.run(sql`UPDATE picking_task_lines SET picked_quantity=requested_quantity WHERE picking_task_id=${pick.pickingTaskId}`);
    await db.run(sql`UPDATE picking_tasks SET status='Picked', completed_at=${new Date().toISOString()} WHERE id=${pick.pickingTaskId}`);
    await createPackingTask(db, "env", { commandId: "cmd-c-pack1", idempotencyKey: "c-pack1", payload: { pickingTaskId: pick.pickingTaskId } }, "order-c");
    await expect(createPackingTask(db, "env", { commandId: "cmd-c-pack2", idempotencyKey: "c-pack2", payload: { pickingTaskId: pick.pickingTaskId } }, "order-c")).rejects.toBeInstanceOf(ConflictError);
    expect(await db.all(sql`SELECT * FROM packing_tasks WHERE picking_task_id=${pick.pickingTaskId}`)).toHaveLength(1);
    expect(await db.all(sql`SELECT * FROM packing_task_lines`)).toHaveLength(1);
    expect(await db.all(sql`SELECT * FROM warehouse_events WHERE event_type='PackingCreated'`)).toHaveLength(1);
  });

  it("D: a Cancelled packing task does not block a new one for the same picking task", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-d", ["item-d1"]);
    const pick: any = await createPickingTask(db, "env", env({}, "d-pick"), "order-d");
    await db.run(sql`UPDATE picking_task_lines SET picked_quantity=requested_quantity WHERE picking_task_id=${pick.pickingTaskId}`);
    await db.run(sql`UPDATE picking_tasks SET status='Picked', completed_at=${new Date().toISOString()} WHERE id=${pick.pickingTaskId}`);
    const firstPack: any = await createPackingTask(db, "env", { commandId: "cmd-d-pack1", idempotencyKey: "d-pack1", payload: { pickingTaskId: pick.pickingTaskId } }, "order-d");
    await updatePacking(db, "env", { commandId: "cmd-d-cancel", idempotencyKey: "d-cancel", payload: {} }, firstPack.packingTaskId, "CancelPackingTask");
    const secondPack: any = await createPackingTask(db, "env", { commandId: "cmd-d-pack2", idempotencyKey: "d-pack2", payload: { pickingTaskId: pick.pickingTaskId } }, "order-d");
    expect(secondPack.status).toBe("Succeeded");
    expect(await db.all(sql`SELECT * FROM packing_tasks WHERE picking_task_id=${pick.pickingTaskId}`)).toHaveLength(2);
  });

  it("E: rejected duplicate creation marks the command Failed with a safe error code", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-e", ["item-e1"]);
    await createPickingTask(db, "env", env({}, "e-first"), "order-e");
    await expect(createPickingTask(db, "env", env({}, "e-second"), "order-e")).rejects.toBeInstanceOf(ConflictError);
    const [row]: any = await db.all(sql`SELECT * FROM erp_command_executions WHERE idempotency_key='e-second'`);
    expect(row.status).toBe("Failed");
    expect(row.safe_error_code).toBe("ConflictError");
  });
});
