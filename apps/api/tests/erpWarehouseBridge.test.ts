import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";
import {
  availability, createWarehouse, createWarehouseLocation, listWarehouses, assignProductLocation,
  createReservation, changeReservation, updateWarehouseStatus, createPickingTask, updatePicking,
  createPackingTask, updatePacking,
} from "../src/services/erpWarehouseBridge";

describe("ERP warehouse bridge schema and services", () => {
  it("adds warehouse tables idempotently and enforces code uniqueness", async () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite); ensureSchema(sqlite);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>;
    expect(tables.map(t=>t.name)).toContain("warehouses");
    expect(tables.map(t=>t.name)).toContain("stock_reservations");
    const db = drizzle(sqlite) as any;
    await createWarehouse(db, "client", { commandId:"c1", idempotencyKey:"k1", commandType:"CreateWarehouse", payload:{ code:"MAIN", name:"Main" } });
    await expect(createWarehouse(db, "client", { commandId:"c2", idempotencyKey:"k2", commandType:"CreateWarehouse", payload:{ code:"MAIN", name:"Other" } })).rejects.toThrow();
    expect(await listWarehouses(db)).toHaveLength(1);
  });

  it("creates nested locations and derives non-negative availability without stock mutation", async () => {
    const sqlite = new Database(":memory:"); ensureSchema(sqlite);
    sqlite.prepare("INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, price_eur, created_at, updated_at) VALUES ('p1','SKU','Title','slug','UniqueItem','Draft',5,10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
    const db = drizzle(sqlite) as any;
    const w = await createWarehouse(db, "client", { commandId:"c1", idempotencyKey:"k1", commandType:"CreateWarehouse", payload:{ code:"MAIN", name:"Main" } });
    const loc = await createWarehouseLocation(db, "client", { commandId:"c2", idempotencyKey:"k2", commandType:"CreateWarehouseLocation", payload:{ warehouseId:w.warehouseId, code:"BIN", name:"Bin" } });
    expect(loc.locationId).toBeTruthy();
    expect(await availability(db, "p1")).toMatchObject({ physicalQuantity:5, reservedQuantity:0, availableQuantity:5 });
  });
});

describe("warehouse command reliability lifecycle (Sprint 51B)", () => {
  function setup() {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const db = drizzle(sqlite) as any;
    return { sqlite, db };
  }
  const env = (commandType:string, payload:any, key="idem-1") => ({ commandId:`cmd-${key}`, requestId:`req-${key}`, commandType, entityType:"Warehouse", idempotencyKey:key, payload });
  const checksumFor = (type:string, entityId:string|undefined, payload:any) => createHash("sha256").update(JSON.stringify({ type, entityId, payload: payload ?? {} })).digest("hex");
  const cmdRow = async (db:any, key:string) => (await db.all(sql`SELECT * FROM erp_command_executions WHERE idempotency_key=${key}`))[0];
  const cmdRows = async (db:any, key:string) => await db.all(sql`SELECT * FROM erp_command_executions WHERE idempotency_key=${key}`);
  function insertOrder(sqlite:Database.Database, orderId:string, itemIds:string[]) {
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

  it("A: successful lifecycle reaches Succeeded; replay returns stored result without duplicating", async () => {
    const { db } = setup();
    const out:any = await createWarehouse(db, "env", env("CreateWarehouse", { code:"A1", name:"A Warehouse" }, "a1"));
    expect(out.status).toBe("Succeeded");
    const row = await cmdRow(db, "a1");
    expect(row.status).toBe("Succeeded");
    expect(row.completed_at).toBeTruthy();
    expect(row.safe_error_code).toBeNull();
    const replay:any = await createWarehouse(db, "env", env("CreateWarehouse", { code:"A1", name:"A Warehouse" }, "a1"));
    expect(replay.status).toBe("Succeeded");
    expect(await db.all(sql`SELECT * FROM warehouses`)).toHaveLength(1);
    expect(await db.all(sql`SELECT * FROM warehouse_events`)).toHaveLength(1);
  });

  it("B: a validation failure marks Failed with a safe error code; no business row or event is written", async () => {
    const { db } = setup();
    await expect(createWarehouse(db, "env", env("CreateWarehouse", { code:"", name:"" }, "b1"))).rejects.toBeInstanceOf(BadRequestError);
    const row = await cmdRow(db, "b1");
    expect(row.status).toBe("Failed");
    expect(row.safe_error_code).toBe("BadRequestError");
    expect(row.completed_at).toBeTruthy();
    expect(await db.all(sql`SELECT * FROM warehouses`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM warehouse_events`)).toHaveLength(0);
  });

  it("C: retrying the same key/checksum after Failed reuses the row, refreshes createdAt, and can reach Succeeded", async () => {
    const { db } = setup();
    const payload = { warehouseId: "missing-warehouse-c", code:"LOC-C", name:"Loc C" };
    await expect(createWarehouseLocation(db, "env", env("CreateWarehouseLocation", payload, "c1"))).rejects.toBeInstanceOf(NotFoundError);
    const failedRow = await cmdRow(db, "c1");
    expect(failedRow.status).toBe("Failed");
    expect(failedRow.safe_error_code).toBe("NotFoundError");
    // Fix the failure condition without changing the payload/checksum: create the referenced warehouse.
    const t = new Date().toISOString();
    await db.run(sql`INSERT INTO warehouses (id,name,code,status,created_at,updated_at) VALUES ('missing-warehouse-c','W','WCODE-C','Active',${t},${t})`);
    const retried:any = await createWarehouseLocation(db, "env", env("CreateWarehouseLocation", payload, "c1"));
    expect(retried.status).toBe("Succeeded");
    const rows = await cmdRows(db, "c1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(failedRow.id);
    expect(rows[0].status).toBe("Succeeded");
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThanOrEqual(new Date(failedRow.created_at).getTime());
  });

  it("D: after Failed, retrying with a different payload throws ConflictError without resetting or executing", async () => {
    const { db } = setup();
    const payload = { warehouseId: "missing-warehouse-d", code:"LOC-D", name:"Loc D" };
    await expect(createWarehouseLocation(db, "env", env("CreateWarehouseLocation", payload, "d1"))).rejects.toBeInstanceOf(NotFoundError);
    const failedRow = await cmdRow(db, "d1");
    expect(failedRow.status).toBe("Failed");
    const differentPayload = { warehouseId: "missing-warehouse-d", code:"LOC-D2", name:"Different" };
    await expect(createWarehouseLocation(db, "env", env("CreateWarehouseLocation", differentPayload, "d1"))).rejects.toBeInstanceOf(ConflictError);
    const rowsAfter = await cmdRows(db, "d1");
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].status).toBe("Failed");
    expect(rowsAfter[0].id).toBe(failedRow.id);
    expect(rowsAfter[0].created_at).toBe(failedRow.created_at);
  });

  it("E: a recent Accepted row with a matching checksum throws ConflictError and performs no business writes", async () => {
    const { db } = setup();
    const payload = { code:"E1", name:"E Warehouse" };
    const checksum = checksumFor("CreateWarehouse", undefined, payload);
    await db.run(sql`INSERT INTO erp_command_executions (id,client_id,command_id,request_id,idempotency_key,command_type,entity_type,entity_id,status,request_checksum,created_at) VALUES ('row-e','env','cmd-e1',NULL,'e1','CreateWarehouse','Warehouse',NULL,'Accepted',${checksum},${new Date().toISOString()})`);
    await expect(createWarehouse(db, "env", env("CreateWarehouse", payload, "e1"))).rejects.toThrow("ERP command is already in progress");
    expect(await db.all(sql`SELECT * FROM warehouses WHERE code='E1'`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM warehouse_events`)).toHaveLength(0);
    expect(await cmdRows(db, "e1")).toHaveLength(1);
  });

  it("F: a stale Accepted row (older than 60s) with a matching checksum is reused, createdAt refreshed, and executes to Succeeded", async () => {
    const { db } = setup();
    const payload = { code:"F1", name:"F Warehouse" };
    const checksum = checksumFor("CreateWarehouse", undefined, payload);
    const staleCreatedAt = new Date(Date.now() - 61_000).toISOString();
    await db.run(sql`INSERT INTO erp_command_executions (id,client_id,command_id,request_id,idempotency_key,command_type,entity_type,entity_id,status,request_checksum,created_at) VALUES ('row-f','env','cmd-f1',NULL,'f1','CreateWarehouse','Warehouse',NULL,'Accepted',${checksum},${staleCreatedAt})`);
    const result:any = await createWarehouse(db, "env", env("CreateWarehouse", payload, "f1"));
    expect(result.status).toBe("Succeeded");
    const rows = await cmdRows(db, "f1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("row-f");
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThan(new Date(staleCreatedAt).getTime());
  });

  it("G: two concurrent first calls with the same new idempotency key do not leak a raw SQLite error", async () => {
    const { db } = setup();
    const payload = { code:"G1", name:"G Warehouse" };
    const results = await Promise.allSettled([
      createWarehouse(db, "env", env("CreateWarehouse", payload, "g1")),
      createWarehouse(db, "env", env("CreateWarehouse", payload, "g1")),
    ]);
    for (const r of results) {
      if (r.status === "rejected") expect(String((r.reason as any)?.message ?? r.reason)).not.toMatch(/UNIQUE constraint/i);
    }
    expect(await db.all(sql`SELECT * FROM warehouses WHERE code='G1'`)).toHaveLength(1);
    expect(await cmdRows(db, "g1")).toHaveLength(1);
  });

  it("H: a deterministic failure on a later picking line rolls back the task, all lines, and the event", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-h", ["item-h1", "item-h2"]);
    sqlite.exec(`CREATE TRIGGER fail_picking_line BEFORE INSERT ON picking_task_lines WHEN NEW.order_item_id='item-h2' BEGIN SELECT RAISE(ABORT, 'picking line insert failed'); END`);
    try {
      await expect(createPickingTask(db, "env", env("CreatePickingTask", {}, "h1"), "order-h")).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("picking line insert failed") }) });
    } finally {
      sqlite.exec(`DROP TRIGGER fail_picking_line`);
    }
    expect(await db.all(sql`SELECT * FROM picking_tasks`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM picking_task_lines`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM warehouse_events`)).toHaveLength(0);
    const row = await cmdRow(db, "h1");
    expect(row.status).toBe("Failed");
    expect(row.safe_error_code).toBe("InternalError");
  });

  it("I: a deterministic failure on a later packing line rolls back the task, all lines, and the event", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-i", ["item-i1", "item-i2"]);
    const picked:any = await createPickingTask(db, "env", env("CreatePickingTask", {}, "i-pick"), "order-i");
    await db.run(sql`UPDATE picking_task_lines SET picked_quantity=requested_quantity WHERE picking_task_id=${picked.pickingTaskId}`);
    await db.run(sql`UPDATE picking_tasks SET status='Picked', completed_at=${new Date().toISOString()} WHERE id=${picked.pickingTaskId}`);
    sqlite.exec(`CREATE TRIGGER fail_packing_line BEFORE INSERT ON packing_task_lines WHEN NEW.order_item_id='item-i2' BEGIN SELECT RAISE(ABORT, 'packing line insert failed'); END`);
    try {
      await expect(createPackingTask(db, "env", env("CreatePackingTask", { pickingTaskId: picked.pickingTaskId }, "i1"), "order-i")).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("packing line insert failed") }) });
    } finally {
      sqlite.exec(`DROP TRIGGER fail_packing_line`);
    }
    expect(await db.all(sql`SELECT * FROM packing_tasks`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM packing_task_lines`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM warehouse_events WHERE event_type='PackingCreated'`)).toHaveLength(0);
    const row = await cmdRow(db, "i1");
    expect(row.status).toBe("Failed");
    expect(row.safe_error_code).toBe("InternalError");
  });

  it("J: a deterministic failure on the warehouse_events insert rolls back the business write too", async () => {
    const { sqlite, db } = setup();
    sqlite.exec(`CREATE TRIGGER fail_warehouse_event BEFORE INSERT ON warehouse_events BEGIN SELECT RAISE(ABORT, 'event insert failed'); END`);
    try {
      await expect(createWarehouse(db, "env", env("CreateWarehouse", { code:"J1", name:"J Warehouse" }, "j1"))).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("event insert failed") }) });
    } finally {
      sqlite.exec(`DROP TRIGGER fail_warehouse_event`);
    }
    expect(await db.all(sql`SELECT * FROM warehouses WHERE code='J1'`)).toHaveLength(0);
    expect(await db.all(sql`SELECT * FROM warehouse_events`)).toHaveLength(0);
    const row = await cmdRow(db, "j1");
    expect(row.status).toBe("Failed");
    expect(row.safe_error_code).toBe("InternalError");
  });

  it("K: successful picking and packing commit task, lines and event together and reach Succeeded", async () => {
    const { sqlite, db } = setup();
    insertOrder(sqlite, "order-k", ["item-k1", "item-k2"]);
    const pick:any = await createPickingTask(db, "env", env("CreatePickingTask", {}, "k-pick"), "order-k");
    expect(pick.status).toBe("Succeeded");
    expect(await db.all(sql`SELECT * FROM picking_task_lines WHERE picking_task_id=${pick.pickingTaskId}`)).toHaveLength(2);
    expect(await db.all(sql`SELECT * FROM warehouse_events WHERE event_type='PickingCreated'`)).toHaveLength(1);
    expect((await cmdRow(db, "k-pick")).status).toBe("Succeeded");

    await db.run(sql`UPDATE picking_task_lines SET picked_quantity=requested_quantity WHERE picking_task_id=${pick.pickingTaskId}`);
    await db.run(sql`UPDATE picking_tasks SET status='Picked', completed_at=${new Date().toISOString()} WHERE id=${pick.pickingTaskId}`);

    const pack:any = await createPackingTask(db, "env", env("CreatePackingTask", { pickingTaskId: pick.pickingTaskId }, "k-pack"), "order-k");
    expect(pack.status).toBe("Succeeded");
    expect(await db.all(sql`SELECT * FROM packing_task_lines WHERE packing_task_id=${pack.packingTaskId}`)).toHaveLength(2);
    expect(await db.all(sql`SELECT * FROM warehouse_events WHERE event_type='PackingCreated'`)).toHaveLength(1);
    expect((await cmdRow(db, "k-pack")).status).toBe("Succeeded");
  });

  it("L: existing behaviors are preserved across locations, reservations, status updates, and picking/packing actions", async () => {
    const { sqlite, db } = setup();
    const productId = "product-l";
    const t = new Date().toISOString();
    sqlite.prepare("INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, price_eur, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(productId, "SKU-L", "Title L", "title-l", "UniqueItem", "Draft", 5, 10, t, t);

    const wh:any = await createWarehouse(db, "env", env("CreateWarehouse", { code:"L1", name:"L Warehouse" }, "l-wh"));
    const loc:any = await createWarehouseLocation(db, "env", env("CreateWarehouseLocation", { warehouseId: wh.warehouseId, code:"BIN-L", name:"Bin L" }, "l-loc"));
    const assign:any = await assignProductLocation(db, "env", env("AssignProductLocation", { productId, warehouseLocationId: loc.locationId, isPrimary:true }, "l-assign"));
    expect(assign.assignmentId).toBeTruthy();
    expect((await cmdRow(db, "l-assign")).status).toBe("Succeeded");

    const reserve:any = await createReservation(db, "env", env("CreateReservation", { productId, quantity:2, reservationReference:"REF-L", reason:"hold" }, "l-reserve"));
    expect(reserve.status).toBe("Succeeded");
    expect(await availability(db, productId)).toMatchObject({ physicalQuantity:5, reservedQuantity:2, availableQuantity:3 });

    const release:any = await changeReservation(db, "env", env("ReleaseReservation", {}, "l-release"), reserve.reservationId, "Released");
    expect(release.status).toBe("Released");
    expect((await cmdRow(db, "l-release")).status).toBe("Succeeded");
    expect(await availability(db, productId)).toMatchObject({ availableQuantity:5 });

    const deactivate:any = await updateWarehouseStatus(db, "env", env("DeactivateWarehouse", {}, "l-deactivate"), wh.warehouseId, "Inactive");
    expect(deactivate.status).toBe("Inactive");
    expect((await cmdRow(db, "l-deactivate")).status).toBe("Succeeded");

    insertOrder(sqlite, "order-l", ["item-l1"]);
    const pick:any = await createPickingTask(db, "env", env("CreatePickingTask", {}, "l-pick"), "order-l");
    const startPick:any = await updatePicking(db, "env", env("StartPickingTask", {}, "l-pick-start"), pick.pickingTaskId, "StartPickingTask");
    expect(startPick.status).toBe("Succeeded");
    expect(startPick.pickingTaskId).toBe(pick.pickingTaskId);

    await db.run(sql`UPDATE picking_task_lines SET picked_quantity=requested_quantity WHERE picking_task_id=${pick.pickingTaskId}`);
    const complete:any = await updatePicking(db, "env", env("CompletePickingTask", {}, "l-pick-complete"), pick.pickingTaskId, "CompletePickingTask");
    expect(complete.status).toBe("Succeeded");

    const pack:any = await createPackingTask(db, "env", env("CreatePackingTask", { pickingTaskId: pick.pickingTaskId }, "l-pack"), "order-l");
    const startPack:any = await updatePacking(db, "env", env("StartPackingTask", {}, "l-pack-start"), pack.packingTaskId, "StartPackingTask");
    expect(startPack.status).toBe("Succeeded");
  });
});
