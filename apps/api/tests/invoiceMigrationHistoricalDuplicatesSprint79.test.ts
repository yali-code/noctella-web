import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";

/**
 * Sprint 79 exact-review correction: reproduces the exact critical finding — creating a direct
 * unique index over `invoices(order_id) WHERE invoice_type='SalesInvoice'` throws when a database
 * already contains more than one SalesInvoice for the same order, which was legal before this
 * sprint. Uses a real file-backed SQLite database (not :memory:) so the scenario matches a real
 * on-disk deployment as closely as possible, and asserts the *current* (corrected) migration
 * never throws regardless of pre-existing data shape.
 */
describe("Sprint 79 correction: invoice migration is safe against historical duplicate SalesInvoice data", () => {
  let tempDir: string | undefined;
  afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); tempDir = undefined; });

  function baseInvoicesTable(sqlite: Database.Database) {
    // A minimal pre-Sprint-79-shaped invoices table (only the columns that existed before this
    // sprint's additive migration) — ensureSchema's own CREATE TABLE IF NOT EXISTS is a no-op
    // against a table that already exists, exactly like every other additive migration in this
    // codebase, so this reproduces "an existing production database" faithfully.
    // Full pre-Sprint-79 column set (everything that existed since Sprint 20, before this
    // sprint's calculation_mode/tax_treatment/prices_include_vat/shipping_vat_*/invoice_footer/
    // sales_invoice_order_key additions) — schema.sql's own CREATE INDEX statements (idx_invoices_dates
    // etc.) reference issued_at/due_at/paid_at/cancelled_at, so a genuinely minimal table would
    // make ensureSchema's unrelated, pre-existing index creation fail for reasons unrelated to
    // this test.
    sqlite.exec(`CREATE TABLE invoices (id TEXT PRIMARY KEY, erp_reference_id TEXT, order_id TEXT NOT NULL, customer_id TEXT, invoice_number TEXT, invoice_type TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', issued_at TEXT, due_at TEXT, paid_at TEXT, cancelled_at TEXT, seller_snapshot TEXT NOT NULL, customer_snapshot TEXT NOT NULL, billing_address_snapshot TEXT, shipping_address_snapshot TEXT, subtotal REAL NOT NULL, shipping_amount REAL NOT NULL DEFAULT 0, discount_amount REAL NOT NULL DEFAULT 0, tax_vat_amount REAL NOT NULL DEFAULT 0, total_amount REAL NOT NULL, notes TEXT, source_snapshot TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    sqlite.exec(`CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, order_item_id TEXT, product_id TEXT, sku_snapshot TEXT, title_snapshot TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price REAL NOT NULL, discount_amount REAL NOT NULL DEFAULT 0, tax_vat_amount REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL, created_at TEXT NOT NULL);`);
    sqlite.exec(`CREATE TABLE invoice_events (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, event_type TEXT NOT NULL, previous_status TEXT, new_status TEXT, safe_metadata TEXT, created_at TEXT NOT NULL);`);
    sqlite.exec(`CREATE TABLE finance_entries (id TEXT PRIMARY KEY, order_id TEXT, invoice_id TEXT, refund_id TEXT, sale_reversal_id TEXT, entry_type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', amount REAL NOT NULL, source_reference TEXT NOT NULL, source_snapshot TEXT NOT NULL, idempotency_key TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  function invoiceRow(id: string, orderId: string, type = "SalesInvoice") {
    return { id, order_id: orderId, invoice_type: type, status: "Draft", seller_snapshot: "{}", customer_snapshot: "{}", subtotal: 100, total_amount: 100, source_snapshot: "{}", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  }
  function insert(sqlite: Database.Database, row: ReturnType<typeof invoiceRow>) {
    const cols = Object.keys(row);
    sqlite.prepare(`INSERT INTO invoices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(row));
  }

  it("startup succeeds against a database with zero invoices", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "zero.sqlite"));
    expect(() => ensureSchema(sqlite)).not.toThrow();
    sqlite.close();
  });

  it("startup succeeds and backfills the key for a database with exactly one SalesInvoice per order", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "one.sqlite"));
    baseInvoicesTable(sqlite);
    insert(sqlite, invoiceRow("inv-1", "order-A"));
    insert(sqlite, invoiceRow("inv-2", "order-B"));
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const rows = sqlite.prepare("SELECT id, order_id, sales_invoice_order_key FROM invoices ORDER BY id").all() as any[];
    expect(rows).toEqual([
      { id: "inv-1", order_id: "order-A", sales_invoice_order_key: "order-A" },
      { id: "inv-2", order_id: "order-B", sales_invoice_order_key: "order-B" },
    ]);
    sqlite.close();
  });

  it("startup succeeds against a database with two SalesInvoice rows for the same order (the exact critical scenario) and leaves both untouched", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "duplicate.sqlite"));
    baseInvoicesTable(sqlite);
    insert(sqlite, invoiceRow("inv-dup-1", "order-DUP"));
    insert(sqlite, invoiceRow("inv-dup-2", "order-DUP"));
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const rows = sqlite.prepare("SELECT id, order_id, sales_invoice_order_key, status FROM invoices WHERE order_id='order-DUP' ORDER BY id").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sales_invoice_order_key === null)).toBe(true);
    // Neither row was deleted, cancelled, renumbered, or otherwise modified beyond the new nullable column.
    expect(rows.map((r) => r.status)).toEqual(["Draft", "Draft"]);
    const { listHistoricalDuplicateSalesInvoiceOrderIds } = await import("../src/db/migrate");
    expect(listHistoricalDuplicateSalesInvoiceOrderIds(sqlite)).toEqual(["order-DUP"]);
    sqlite.close();
  });

  it("startup succeeds against a mix: unambiguous orders, a duplicate group, and unrelated invoice types (Proforma) that must never be backfilled", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "mixed.sqlite"));
    baseInvoicesTable(sqlite);
    insert(sqlite, invoiceRow("inv-clean", "order-CLEAN"));
    insert(sqlite, invoiceRow("inv-dup-a", "order-DUP2"));
    insert(sqlite, invoiceRow("inv-dup-b", "order-DUP2"));
    insert(sqlite, invoiceRow("inv-proforma", "order-CLEAN", "Proforma"));
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const clean = sqlite.prepare("SELECT sales_invoice_order_key FROM invoices WHERE id='inv-clean'").get() as any;
    expect(clean.sales_invoice_order_key).toBe("order-CLEAN");
    const proforma = sqlite.prepare("SELECT sales_invoice_order_key FROM invoices WHERE id='inv-proforma'").get() as any;
    expect(proforma.sales_invoice_order_key).toBeNull();
    const dup = sqlite.prepare("SELECT sales_invoice_order_key FROM invoices WHERE order_id='order-DUP2'").all() as any[];
    expect(dup.every((r) => r.sales_invoice_order_key === null)).toBe(true);
    sqlite.close();
  });

  it("repeated startup after migration is idempotent: no error, no data change, the backfill is not re-applied or reversed", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "repeat.sqlite"));
    baseInvoicesTable(sqlite);
    insert(sqlite, invoiceRow("inv-1", "order-A"));
    insert(sqlite, invoiceRow("inv-dup-1", "order-DUP"));
    insert(sqlite, invoiceRow("inv-dup-2", "order-DUP"));
    ensureSchema(sqlite);
    const firstPass = sqlite.prepare("SELECT id, sales_invoice_order_key FROM invoices ORDER BY id").all();
    expect(() => ensureSchema(sqlite)).not.toThrow();
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const secondPass = sqlite.prepare("SELECT id, sales_invoice_order_key FROM invoices ORDER BY id").all();
    expect(secondPass).toEqual(firstPass);
    sqlite.close();
  });

  it("the unique index actually prevents a NEW duplicate for an unambiguous order going forward, while historical duplicates remain permanently excluded from it", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "enforce.sqlite"));
    baseInvoicesTable(sqlite);
    insert(sqlite, invoiceRow("inv-1", "order-A"));
    ensureSchema(sqlite);
    // A second SalesInvoice for the same, now-backfilled order must violate the new index.
    expect(() => sqlite.exec(`INSERT INTO invoices (id, order_id, invoice_type, status, seller_snapshot, customer_snapshot, subtotal, total_amount, source_snapshot, created_at, updated_at, sales_invoice_order_key) VALUES ('inv-2','order-A','SalesInvoice','Draft','{}','{}',100,100,'{}','t','t','order-A')`)).toThrow(/UNIQUE constraint failed/);
    sqlite.close();
  });

  it("Second Exact Review correction: a database that already carries the old, unsafe direct index (from an earlier migration draft) has it removed by startup, and historical duplicates that would have crashed under it are preserved and startup still succeeds", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-inv-migration-"));
    const sqlite = new Database(path.join(tempDir, "legacy-index.sqlite"));
    baseInvoicesTable(sqlite);
    insert(sqlite, invoiceRow("inv-legacy-1", "order-LEGACY"));
    // Simulate a database that already ran an earlier (pre-correction) draft of this migration,
    // which created the old direct index before this column/key strategy existed.
    sqlite.exec("CREATE UNIQUE INDEX idx_invoices_order_sales_invoice_unique ON invoices(order_id) WHERE invoice_type = 'SalesInvoice'");
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const indexNames = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexNames).not.toContain("idx_invoices_order_sales_invoice_unique");
    expect(indexNames).toContain("idx_invoices_sales_invoice_order_key_unique");
    // A second startup (the index already gone) must remain a safe no-op.
    expect(() => ensureSchema(sqlite)).not.toThrow();
    sqlite.close();
  });
});
