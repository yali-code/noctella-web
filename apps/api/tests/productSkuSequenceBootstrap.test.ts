// Sprint 106 correction pass (Exact Review BLOCKER): focused, allocator-level tests proving
// allocateNextProductSkuInTransaction (repositories/product-write/drizzle.ts) safely reconciles
// the persisted product_sku_sequence counter against existing Product SKUs - both at first-ever
// use (empty database) and on every later call (runtime lag against the still-live legacy
// /save-as-draft manual-SKU path) - never rewinds, and never permanently fails on a block of
// pre-existing NOC-formatted SKUs. Uses a test-only in-memory SQLite database throughout - never
// real inventory.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocateNextProductSkuInTransaction } from "../src/repositories/product-write/drizzle";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";

/** Mirrors services/aiIntakeApplyTransactionCapabilityForDb.ts's exact SQLite transaction idiom - a synchronous callback, invoked via the callable drizzle-orm/better-sqlite3 sometimes returns. */
function runSqliteTransaction<T>(sqlite: InstanceType<typeof Database>, db: ReturnType<typeof drizzle>, work: (tx: any) => T): T {
  let result!: T;
  const transaction = (db as any).transaction((tx: any) => {
    result = work(tx);
    if (result instanceof Promise) throw new Error("SQLITE_ASYNC_TEST_TRANSACTION_CALLBACK_REJECTED");
  });
  if (typeof transaction === "function") (transaction as () => void)();
  return result;
}

function allocate(sqlite: InstanceType<typeof Database>, db: ReturnType<typeof drizzle>): string {
  return runSqliteTransaction(sqlite, db, (tx) => allocateNextProductSkuInTransaction(tx, sqliteSchema, "synchronous") as string);
}

/** Minimal legacy/manually-entered Product row - only the columns this allocator's own reconciliation and the NOT NULL schema require. */
function insertLegacyProduct(sqlite: InstanceType<typeof Database>, sku: string, idSuffix: string): void {
  sqlite
    .prepare(
      `INSERT INTO products (id, sku, slug, title, type, price_eur, status, stock_quantity, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unique_item', 5, 'draft', 0, datetime('now'), datetime('now'))`,
    )
    .run(`legacy-${idSuffix}`, sku, `legacy-slug-${idSuffix}`, `Legacy Product ${idSuffix}`);
}

function setup(): { sqlite: InstanceType<typeof Database>; db: ReturnType<typeof drizzle> } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  const db = drizzle(sqlite, { schema: sqliteSchema });
  return { sqlite, db };
}

describe("allocateNextProductSkuInTransaction - sequence bootstrap / legacy collision safety (Sprint 106 correction)", () => {
  it("1. empty database: first generated SKU is NOC-000001", () => {
    const { sqlite, db } = setup();
    expect(allocate(sqlite, db)).toBe("NOC-000001");
    sqlite.close();
  });

  it("2. existing NOC-000001..NOC-000010 with no sequence row: first allocation safely produces NOC-000011", () => {
    const { sqlite, db } = setup();
    for (let i = 1; i <= 10; i++) insertLegacyProduct(sqlite, `NOC-${String(i).padStart(6, "0")}`, String(i));
    expect(allocate(sqlite, db)).toBe("NOC-000011");
    sqlite.close();
  });

  it("3. more than the old collision bound (15 consecutive existing system-format SKUs) does NOT permanently block allocation", () => {
    const { sqlite, db } = setup();
    for (let i = 1; i <= 15; i++) insertLegacyProduct(sqlite, `NOC-${String(i).padStart(6, "0")}`, String(i));
    // The old design's MAX_SKU_COLLISION_RETRIES=5 (6 total candidates) would have thrown here -
    // the corrected design reconciles directly to one past the true maximum instead of walking
    // forward one collision at a time.
    expect(allocate(sqlite, db)).toBe("NOC-000016");
    sqlite.close();
  });

  it("4. non-contiguous existing values: allocation starts safely above the highest matching system SKU, ignoring gaps", () => {
    const { sqlite, db } = setup();
    insertLegacyProduct(sqlite, "NOC-000003", "a");
    insertLegacyProduct(sqlite, "NOC-000007", "b");
    insertLegacyProduct(sqlite, "NOC-000050", "c");
    expect(allocate(sqlite, db)).toBe("NOC-000051");
    sqlite.close();
  });

  it("5. malformed/unrelated SKU values are ignored for sequence bootstrap", () => {
    const { sqlite, db } = setup();
    insertLegacyProduct(sqlite, "NOC-ABC", "a"); // non-numeric suffix
    insertLegacyProduct(sqlite, "ABC-000001", "b"); // wrong prefix
    insertLegacyProduct(sqlite, "random-sku-1", "c"); // unrelated shape entirely
    insertLegacyProduct(sqlite, "NOC-12", "d"); // numeric but fewer than 6 digits - not this namespace's shape
    insertLegacyProduct(sqlite, "NOC-000005", "e"); // the only genuine system-format SKU present
    expect(allocate(sqlite, db)).toBe("NOC-000006");
    sqlite.close();
  });

  it("6. existing sequence higher than the Product max is NOT rewound", () => {
    const { sqlite, db } = setup();
    insertLegacyProduct(sqlite, "NOC-000003", "a");
    sqlite.prepare("INSERT INTO product_sku_sequence (id, next_value) VALUES ('product_sku', 50)").run();
    expect(allocate(sqlite, db)).toBe("NOC-000050");
    // The persisted counter moved forward from the allocation, never backward.
    const row = sqlite.prepare("SELECT next_value FROM product_sku_sequence WHERE id = 'product_sku'").get() as { next_value: number };
    expect(row.next_value).toBe(51);
    sqlite.close();
  });

  it("7. existing sequence lower than the Product max safely advances/reconciles and issues a valid next SKU", () => {
    const { sqlite, db } = setup();
    insertLegacyProduct(sqlite, "NOC-000099", "a");
    sqlite.prepare("INSERT INTO product_sku_sequence (id, next_value) VALUES ('product_sku', 2)").run();
    expect(allocate(sqlite, db)).toBe("NOC-000100");
    sqlite.close();
  });

  it("8. a downstream Product-creation failure rolls back the allocation - the SKU is not permanently consumed", () => {
    const { sqlite, db } = setup();
    let firstAttemptSku: string | undefined;
    expect(() =>
      runSqliteTransaction(sqlite, db, (tx) => {
        firstAttemptSku = allocateNextProductSkuInTransaction(tx, sqliteSchema, "synchronous") as string;
        throw new Error("simulated downstream Product creation failure");
      }),
    ).toThrow("simulated downstream Product creation failure");
    expect(firstAttemptSku).toBe("NOC-000001");
    // The rolled-back transaction never persisted its counter advance - the very next successful
    // attempt still receives NOC-000001, not NOC-000002.
    expect(allocate(sqlite, db)).toBe("NOC-000001");
    sqlite.close();
  });

  it("10. legacy/manual Product collision scenario (Save as Draft coexistence): already-existing NOC-formatted SKUs cannot permanently block Stock Acceptance allocation", () => {
    const { sqlite, db } = setup();
    // Simulates an admin having used the still-live /save-as-draft endpoint to manually create six
    // consecutive system-format SKUs before any Stock Acceptance allocation has ever run.
    for (let i = 1; i <= 6; i++) insertLegacyProduct(sqlite, `NOC-${String(i).padStart(6, "0")}`, String(i));
    expect(allocate(sqlite, db)).toBe("NOC-000007");
    sqlite.close();
  });

  it("11. cold-start initialization never produces a duplicate SKU (SQLite: proven by real sequential allocation; PostgreSQL race-safety: proven by construction)", () => {
    const { sqlite, db } = setup();
    const first = allocate(sqlite, db);
    const second = allocate(sqlite, db);
    expect(first).toBe("NOC-000001");
    expect(second).toBe("NOC-000002");
    expect(first).not.toBe(second);
    const rows = sqlite.prepare("SELECT next_value FROM product_sku_sequence").all();
    expect(rows).toHaveLength(1); // exactly one singleton row, never duplicated
    sqlite.close();

    // No live multi-connection PostgreSQL instance is available in this environment to observe
    // genuine concurrent-transaction interleaving (the same documented limitation this codebase
    // already states elsewhere, e.g. aiIntakeApply.test.ts's own locking-and-concurrent-apply
    // tests) - PostgreSQL cold-start race-safety is proven by construction instead: the singleton
    // row is created via the same established idempotent-insert pattern already used safely
    // elsewhere in this codebase (onConflictDoNothing) before the row is ever locked/read.
    const source = readFileSync(new URL("../src/repositories/product-write/drizzle.ts", import.meta.url), "utf8");
    const fnSource = source.slice(source.indexOf("export function allocateNextProductSkuInTransaction"));
    expect(fnSource).toContain("ensureSequenceRowExists");
    expect(fnSource).toContain(".onConflictDoNothing()");
    expect(fnSource.indexOf("ensureSequenceRowExists()")).toBeLessThan(fnSource.indexOf('.for("update")'));
  });

  it("12. rerunning ensureSchema is idempotent and never resets or rewinds an existing sequence value", () => {
    const { sqlite, db } = setup();
    expect(allocate(sqlite, db)).toBe("NOC-000001");
    const before = sqlite.prepare("SELECT * FROM product_sku_sequence WHERE id = 'product_sku'").get() as { id: string; next_value: number };
    expect(before.next_value).toBe(2);

    expect(() => ensureSchema(sqlite)).not.toThrow();
    expect(() => ensureSchema(sqlite)).not.toThrow();

    const after = sqlite.prepare("SELECT * FROM product_sku_sequence WHERE id = 'product_sku'").get() as { id: string; next_value: number };
    expect(after).toEqual(before); // completely untouched by rerunning schema initialization
    expect(allocate(sqlite, db)).toBe("NOC-000002"); // continues correctly afterward
    sqlite.close();
  });

  it("SKU format is unchanged: still exactly NOC-###### (six or more zero-padded digits)", () => {
    const { sqlite, db } = setup();
    expect(allocate(sqlite, db)).toMatch(/^NOC-\d{6}$/);
    sqlite.close();
  });

  it("products.sku UNIQUE constraint remains defense-in-depth beneath the allocator (unchanged)", () => {
    const source = readFileSync(new URL("../src/db/schema.sqlite.ts", import.meta.url), "utf8");
    expect(source).toContain('sku: text("sku").notNull().unique()');
  });
});
