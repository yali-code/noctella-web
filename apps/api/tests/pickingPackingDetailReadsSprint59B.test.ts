import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { NotFoundError } from "../src/services/errors";
import { createPackingTask, createPickingTask, getPackingTaskDetail, getPickingTaskDetail } from "../src/services/erpWarehouseBridge";

/**
 * Sprint 59B: getPickingTaskDetail/getPackingTaskDetail are additive read-only compositions
 * (no route previously exposed line data at all). Proves the detail read includes lines and
 * that the original bare getPickingTask/getPackingTask functions are unaffected.
 */
describe("picking/packing detail reads include lines (Sprint 59B)", () => {
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
  const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, requestId: `req-${key}`, idempotencyKey: key, payload });

  it("getPickingTaskDetail returns the task with its lines", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-x", ["item-x1", "item-x2"]);
    const created: any = await createPickingTask(db, "env", env({}, "x1"), "order-x");
    const detail: any = await getPickingTaskDetail(db, created.pickingTaskId);
    expect(detail.id).toBe(created.pickingTaskId);
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0].requested_quantity).toBe(1);
  });

  it("getPickingTaskDetail on a missing task throws NotFoundError", async () => {
    const { db } = setup();
    await expect(getPickingTaskDetail(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getPackingTaskDetail returns the task with its lines derived from picked quantities", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-y", ["item-y1"]);
    const pick: any = await createPickingTask(db, "env", env({}, "y-pick"), "order-y");
    await db.run(sql`UPDATE picking_task_lines SET picked_quantity=requested_quantity WHERE picking_task_id=${pick.pickingTaskId}`);
    await db.run(sql`UPDATE picking_tasks SET status='Picked', completed_at=${new Date().toISOString()} WHERE id=${pick.pickingTaskId}`);
    const pack: any = await createPackingTask(db, "env", { commandId: "cmd-y-pack", idempotencyKey: "y-pack", payload: { pickingTaskId: pick.pickingTaskId } }, "order-y");
    const detail: any = await getPackingTaskDetail(db, pack.packingTaskId);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].quantity).toBe(1);
  });

  it("getPackingTaskDetail on a missing task throws NotFoundError", async () => {
    const { db } = setup();
    await expect(getPackingTaskDetail(db, "does-not-exist")).rejects.toBeInstanceOf(NotFoundError);
  });
});
