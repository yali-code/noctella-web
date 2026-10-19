/**
 * #458 (audit C1): the photo-ownership authority must use the SQL dialect and transaction model of the configured
 * runtime driver. "supabase-postgres" is PostgreSQL; unknown values are refused instead of guessed as SQLite; an
 * asynchronous client on the synchronous SQLite path fails loudly without an unhandled rejection. No database needed;
 * real W2/W4 routing on SQLite and PostgreSQL is in w4FencedFinalizationAcceptance.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { inOwnershipTransaction, nowMs, ownershipDriver, uniqueViolation } from "../src/services/photoOperationAuthority";

describe("ownership claim duplicate classification", () => {
  it("recognizes a PostgreSQL duplicate wrapped by Drizzle", () => {
    const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    expect(uniqueViolation(new Error("Failed query: INSERT INTO photo_derivative_operations", { cause: driverError }))).toBe(true);
  });

  it("preserves SQLite duplicate handling without swallowing other constraint failures", () => {
    expect(uniqueViolation(Object.assign(new Error("UNIQUE constraint failed: photo_operations.subject_id"), { code: "SQLITE_CONSTRAINT_UNIQUE" }))).toBe(true);
    expect(uniqueViolation(Object.assign(new Error("FOREIGN KEY constraint failed"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }))).toBe(false);
    expect(uniqueViolation(Object.assign(new Error("not null"), { code: "23502" }))).toBe(false);
    expect(uniqueViolation(new Error("Failed query", { cause: Object.assign(new Error("disk full"), { code: "SQLITE_FULL" }) }))).toBe(false);
  });

  it("terminates on cyclic causes and ignores unrelated messages", () => {
    const error: any = new Error("Failed query: SELECT 'UNIQUE constraint failed:'");
    error.cause = error;
    expect(uniqueViolation(error)).toBe(false);
    expect(uniqueViolation(null)).toBe(false);
  });
});

const sqlText = (statement: any) => statement.queryChunks.map((c: any) => (typeof c === "string" ? c : c.value?.join?.("") ?? "")).join("");

describe("ownershipDriver", () => {
  it.each([
    [{}, "sqlite"],
    [{ DATABASE_DRIVER: "sqlite" }, "sqlite"],
    [{ DATABASE_DRIVER: "postgres" }, "postgres"],
    [{ DATABASE_DRIVER: "supabase-postgres" }, "postgres"],
    [{ DATABASE_DRIVER: "test-memory", NODE_ENV: "test" }, "sqlite"],
  ] as Array<[NodeJS.ProcessEnv, string]>)("%j -> %s", (env, expected) => {
    expect(ownershipDriver(env)).toBe(expected);
  });

  it.each([["mysql"], ["Postgres"], ["postgresql"], [""], ["supabase"]])("refuses unsupported DATABASE_DRIVER %j", (value) => {
    expect(() => ownershipDriver({ DATABASE_DRIVER: value })).toThrow(`UNSUPPORTED_PHOTO_OWNERSHIP_DRIVER:${value}`);
  });

  it("refuses the test-memory driver outside NODE_ENV=test", () => {
    expect(() => ownershipDriver({ DATABASE_DRIVER: "test-memory", NODE_ENV: "production" })).toThrow("UNSUPPORTED_PHOTO_OWNERSHIP_DRIVER:test-memory");
  });

  it("reads process.env by default (existing call sites)", () => {
    const saved = process.env.DATABASE_DRIVER;
    try {
      process.env.DATABASE_DRIVER = "supabase-postgres";
      expect(ownershipDriver()).toBe("postgres");
    } finally { if (saved === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = saved; }
  });

  it("supabase-postgres gets the PostgreSQL database clock, sqlite the SQLite one", () => {
    expect(sqlText(nowMs(ownershipDriver({ DATABASE_DRIVER: "supabase-postgres" })))).toContain("clock_timestamp()");
    expect(sqlText(nowMs(ownershipDriver({ DATABASE_DRIVER: "sqlite" })))).toContain("unixepoch('subsec')");
  });
});

describe("inOwnershipTransaction driver mismatch", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  afterEach(() => { process.off("unhandledRejection", onUnhandled); unhandled.length = 0; });

  it("an asynchronous client on the SQLite path throws a clear error and leaves no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    // node-postgres drizzle shape: transaction(cb) returns a Promise; its tx has execute(), not all().
    const pgLike = { transaction: (cb: (tx: unknown) => unknown) => Promise.resolve().then(() => cb({ execute: async () => ({ rows: [] }) })) };
    expect(() => inOwnershipTransaction(pgLike as any, "sqlite", function* () { return yield sql`SELECT 1`; }))
      .toThrow("PHOTO_OWNERSHIP_DRIVER_MISMATCH");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it("the PostgreSQL path awaits the client's transaction and returns the generator's result", async () => {
    const pgLike = { transaction: (cb: (tx: unknown) => unknown) => Promise.resolve().then(() => cb({ execute: async () => ({ rows: [{ n: 1 }] }) })) };
    await expect(inOwnershipTransaction(pgLike as any, "postgres", function* () { const rows = yield sql`SELECT 1 AS n`; return rows[0].n; })).resolves.toBe(1);
  });
});
