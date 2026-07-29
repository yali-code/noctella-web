import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";

/**
 * Sprint 80 correction: the sales-completion repository used to persist orders.status as the raw
 * string "Completed" (capital C) instead of the canonical OrderStatus.Completed value
 * ("completed"). The write path is fixed; this proves the accompanying idempotent backfill
 * normalizes any historical row a real database may already carry from before that fix, using a
 * real file-backed SQLite database (not :memory:) so the scenario matches an actual on-disk
 * deployment as closely as possible.
 */
describe("Sprint 80 correction: historical orders.status='Completed' rows are normalized on startup", () => {
  let tempDir: string | undefined;
  afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); tempDir = undefined; });

  it("startup normalizes a legacy capitalized 'Completed' row to the canonical lowercase value, leaves other statuses untouched, and is idempotent on repeat startup", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-order-status-casing-"));
    const sqlite = new Database(path.join(tempDir, "legacy-status.sqlite"));
    // A genuinely pre-fix database: ensureSchema first (so the orders table and every other
    // required table/column exists), then simulate the historical bug by directly writing the
    // old capitalized value the buggy repository code used to write.
    ensureSchema(sqlite);
    const now = "2026-01-01T00:00:00.000Z";
    sqlite.exec(`INSERT INTO orders (id, order_number, guest_email, status, payment_status, payment_provider, payment_reference, subtotal_amount, shipping_amount, tax_amount, total_amount, currency, billing_address, shipping_address, created_at, updated_at) VALUES
      ('order-legacy-completed', 'NOC-LEGACY-1', 'legacy@example.invalid', 'Completed', 'paid', 'stripe', 'ref-legacy', 100, 0, 0, 100, 'EUR', '{}', '{}', '${now}', '${now}'),
      ('order-legacy-cancelled', 'NOC-LEGACY-2', 'legacy2@example.invalid', 'cancelled', 'paid', 'stripe', 'ref-legacy-2', 50, 0, 0, 50, 'EUR', '{}', '{}', '${now}', '${now}')`);

    expect(() => ensureSchema(sqlite)).not.toThrow();

    const rows = sqlite.prepare("SELECT id, status FROM orders ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: "order-legacy-cancelled", status: "cancelled" },
      { id: "order-legacy-completed", status: "completed" },
    ]);

    // Repeated startup is a safe no-op - no error, no further data change.
    expect(() => ensureSchema(sqlite)).not.toThrow();
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const rowsAfterRepeat = sqlite.prepare("SELECT id, status FROM orders ORDER BY id").all();
    expect(rowsAfterRepeat).toEqual(rows);

    sqlite.close();
  });

  it("startup succeeds against a database with no legacy-cased rows at all", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-order-status-casing-"));
    const sqlite = new Database(path.join(tempDir, "clean.sqlite"));
    expect(() => ensureSchema(sqlite)).not.toThrow();
    sqlite.close();
  });
});
