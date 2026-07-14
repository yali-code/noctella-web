import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { availability, createWarehouse, createWarehouseLocation, listWarehouses } from "../src/services/erpWarehouseBridge";

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
