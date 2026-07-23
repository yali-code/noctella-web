import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { ConflictError } from "../src/services/errors";
import { availability, createReservation } from "../src/services/erpWarehouseBridge";

/**
 * Sprint 58B: proves the TOCTOU race in createReservation is corrected - availability is now
 * verified inside the same synchronous transaction as the insert, not as a separate prior read.
 */
describe("reservation availability race correction (Sprint 58B)", () => {
  function setup(stockQuantity = 5) {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const t = new Date().toISOString();
    sqlite.prepare("INSERT INTO products (id, sku, title, slug, type, status, stock_quantity, price_eur, created_at, updated_at) VALUES ('p1','SKU','Title','slug','UniqueItem','Draft',?,10,?,?)").run(stockQuantity, t, t);
    const db = drizzle(sqlite) as any;
    return { sqlite, db };
  }
  const env = (payload: any, key: string) => ({ commandId: `cmd-${key}`, requestId: `req-${key}`, commandType: "CreateReservation", entityType: "StockReservation", idempotencyKey: key, payload });

  it("A: a reservation within available stock succeeds", async () => {
    const { db } = setup(5);
    const out: any = await createReservation(db, "env", env({ productId: "p1", quantity: 3, reservationReference: "REF-A", reason: "hold" }, "a1"));
    expect(out.status).toBe("Succeeded");
    expect(await availability(db, "p1")).toMatchObject({ physicalQuantity: 5, reservedQuantity: 3, availableQuantity: 2 });
  });

  it("B: a reservation exceeding available stock is rejected and writes no reservation row", async () => {
    const { db } = setup(5);
    await expect(createReservation(db, "env", env({ productId: "p1", quantity: 6, reservationReference: "REF-B", reason: "hold" }, "b1"))).rejects.toBeInstanceOf(ConflictError);
    expect(await db.all(sql`SELECT * FROM stock_reservations`)).toHaveLength(0);
    expect(await availability(db, "p1")).toMatchObject({ availableQuantity: 5 });
  });

  it("C: a concurrent reservation race - two requests that jointly exceed stock - results in exactly one success and one rejection, never both succeeding", async () => {
    const { db } = setup(5);
    const results = await Promise.allSettled([
      createReservation(db, "env", env({ productId: "p1", quantity: 3, reservationReference: "REF-C1", reason: "hold" }, "c1")),
      createReservation(db, "env", env({ productId: "p1", quantity: 3, reservationReference: "REF-C2", reason: "hold" }, "c2")),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    // Exactly one reservation row exists, and reserved/available reflect only the winner.
    const rows = await db.all(sql`SELECT * FROM stock_reservations`);
    expect(rows).toHaveLength(1);
    expect(await availability(db, "p1")).toMatchObject({ reservedQuantity: 3, availableQuantity: 2 });
  });

  it("D: a duplicate idempotency key (same payload) never duplicates the reservation - replays the original result", async () => {
    const { db } = setup(5);
    const payload = { productId: "p1", quantity: 2, reservationReference: "REF-D", reason: "hold" };
    const first: any = await createReservation(db, "env", env(payload, "d1"));
    const replay: any = await createReservation(db, "env", env(payload, "d1"));
    expect(replay.reservationId ?? replay.resultReference).toBe(first.reservationId);
    expect(await db.all(sql`SELECT * FROM stock_reservations`)).toHaveLength(1);
    expect(await availability(db, "p1")).toMatchObject({ reservedQuantity: 2, availableQuantity: 3 });
  });
});
