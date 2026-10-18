/**
 * Stage 5 F2 WP1 (#472): schema initialization and migration compatibility of the durable publication intent
 * (photo_publication_intents) and executor exit record (photo_executor_exit_records) tables, plus the runtime
 * module's integer and fail-closed behavior. SQLite: schema.sql through ensureSchema. PostgreSQL: the forward-only
 * migration 0043 applied onto a disposable schema migrated through 0041. Nothing here wires the module into an owner.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { claimExistingOperation, createOperation, inOwnershipTransaction, PHOTO_OPERATION_LEASE_MS, type OwnershipDriver } from "../src/services/photoOperationAuthority";
import {
  acquirePublicationIntent, commitIntentAuthorizedPhotoOperation, exactPositiveInteger, guardedReclaimSteps,
  persistAuthenticatedExecutorExitSteps, transferPublicationAuthoritySteps, type PublicationAuthority,
} from "../src/services/photoPublicationIntents";
import { createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";

const MIGRATION = "0043_photo_publication_intents.sql";
const migrationsDir = path.join(__dirname, "../src/db/postgres-migrations");
const migrationSql = () => fs.readFileSync(path.join(migrationsDir, MIGRATION), "utf8");
const WP1_TABLES = ["photo_publication_intents", "photo_executor_exit_records"];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-wp1-schema-"));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

it.runIf(process.env.F2C1_REQUIRE_POSTGRES === "1")("required PostgreSQL execution for the WP1 schema suite is configured", () => {
  expect(postgresTestConfigured).toBe(true);
});

describe("WP1 migration files (forward-only convention)", () => {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  it("uses the next unused number 0043, leaves the reserved 0039/0042 numbers unused and is the only 0043", () => {
    expect(files.filter((f) => f.startsWith("0043_"))).toEqual([MIGRATION]);
    expect(files.filter((f) => f.startsWith("0039_") || f.startsWith("0042_"))).toEqual([]);
    expect(files.filter((f) => f.localeCompare(MIGRATION) > 0)).toEqual([]);
  });
  it("is purely additive: creates only its two tables, never alters, drops or rewrites existing data", () => {
    const body = migrationSql().replace(/--.*$/gm, "");
    expect([...body.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])).toEqual(WP1_TABLES);
    expect(body).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/i);
  });
  it("schema.sql carries the identical DDL for SQLite schema initialization", () => {
    const normalize = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
    const ddl = normalize(migrationSql());
    expect(normalize(fs.readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8"))).toContain(ddl);
  });
});

describe("exactPositiveInteger never converts lossily", () => {
  it("accepts exact positive safe integers from numbers and BIGINT strings", () => {
    expect([1, "1", "42", 9007199254740991, "9007199254740991"].map(exactPositiveInteger)).toEqual([1, 1, 42, 9007199254740991, 9007199254740991]);
  });
  it.each([0, -1, "0", "01", "1.0", 1.5, "9007199254740993", 9007199254740992, "", "abc", null, undefined, Number.NaN])("rejects %s", (value) => {
    expect(() => exactPositiveInteger(value)).toThrow("PHOTO_PUBLICATION_INTEGER_INVALID");
  });
});

interface Harness { db: any; driver: OwnershipDriver; q: (s: SQL) => Promise<any[]>; tableExists: (name: string) => Promise<boolean>; applyWp1: () => Promise<void>; close: () => Promise<void> }

async function sqliteHarness(): Promise<Harness> {
  const raw = new Database(path.join(tmpRoot, `${randomUUID()}.sqlite`));
  raw.pragma("foreign_keys = ON");
  ensureSchema(raw);
  // A database initialized before WP1 has neither table.
  raw.exec("DROP TABLE photo_executor_exit_records; DROP TABLE photo_publication_intents;");
  const db = drizzle(raw, { schema });
  return {
    db, driver: "sqlite", q: async (s) => db.all(s),
    tableExists: async (name) => Boolean(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
    applyWp1: async () => { ensureSchema(raw); },
    close: async () => { raw.close(); },
  };
}

async function postgresHarness(): Promise<Harness> {
  const h: PostgresTestDb = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
  return {
    db: h.db, driver: "postgres", q: async (s) => (await h.db.execute(s)).rows as any[],
    tableExists: async (name) => (await h.pool.query("SELECT to_regclass($1) AS t", [name])).rows[0].t !== null,
    applyWp1: async () => { await h.pool.query(migrationSql()); },
    close: () => h.close(),
  };
}

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("WP1 publication-intent schema on %s", (driver, configured) => {
  let h: Harness;
  const run = (name: string, fn: () => Promise<void>) => it.skipIf(!configured)(name, fn);
  beforeAll(async () => { if (configured) h = driver === "sqlite" ? await sqliteHarness() : await postgresHarness(); });
  afterAll(async () => { await h?.close(); });

  // Always a Promise: a synchronous SQLite throw becomes a rejection.
  const tx = <T>(steps: () => Generator<SQL, T, any>): Promise<T> => Promise.resolve().then(() => inOwnershipTransaction(h.db, driver, steps));
  async function sealedOperation() {
    const photoId = randomUUID();
    const op = await tx(() => createOperation(driver, { kind: "product_upload", subjectType: "w2_request", subjectId: randomUUID(), targetPhotoId: photoId,
      mainKey: `p-${photoId}.webp`, thumbKey: `p-${photoId}-thumb.webp`, inputSha256: "c".repeat(64) }, PHOTO_OPERATION_LEASE_MS));
    const sealId = randomUUID();
    await h.q(sql`INSERT INTO photo_operation_artifacts (id, operation_id, generation, relative_path, main_sha256, thumb_sha256, main_bytes, thumb_bytes, main_dev, main_ino, thumb_dev, thumb_ino, created_ms)
      VALUES (${sealId}, ${op.id}, 1, ${`${op.id}/1`}, ${"a".repeat(64)}, ${"b".repeat(64)}, 10, 5, '1', '100', '1', '101', 1) RETURNING id`);
    await h.q(sql`UPDATE photo_operations SET state = 'sealed', seal_id = ${sealId} WHERE id = ${op.id} RETURNING id`);
    return { op, sealId };
  }
  const snapshot = async () => [
    await h.q(sql`SELECT id, generation, owner, nonce, state, seal_id, lease_until_ms FROM photo_operations ORDER BY id`),
    await h.q(sql`SELECT operation_id, generation, state FROM photo_operation_generations ORDER BY operation_id, generation`),
    await h.q(sql`SELECT id, operation_id, main_sha256, main_dev, main_ino FROM photo_operation_artifacts ORDER BY id`),
  ];
  const expire = (id: string) => h.q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE id = ${id} RETURNING id`);
  const intentInsert = (o: { operationId: string; sealId: string; generation?: unknown; state?: string; epoch?: unknown; token?: string }) =>
    h.q(sql`INSERT INTO photo_publication_intents (operation_id, generation, owner, nonce, seal_id, main_key, thumb_key, main_sha256, main_dev, main_ino,
      thumb_sha256, thumb_dev, thumb_ino, executor_epoch, executor_token, executor_identity, state, created_ms, updated_ms)
      VALUES (${o.operationId}, ${o.generation ?? 1}, 'owner', 'nonce', ${o.sealId}, 'm.webp', 't.webp', ${"a".repeat(64)}, '1', '100', ${"b".repeat(64)}, '1', '101',
      ${o.epoch ?? 1}, ${o.token ?? randomUUID()}, 'executor-x', ${o.state ?? "authorized"}, 1, 1) RETURNING operation_id`);

  // Runs first: upgrades a pre-WP1 database that already holds photo-operation rows.
  run("adds both tables to a pre-WP1 database without changing existing rows, idempotently", async () => {
    const existing = await sealedOperation();
    for (const t of WP1_TABLES) expect(await h.tableExists(t)).toBe(false);
    const before = await snapshot();
    await h.applyWp1();
    for (const t of WP1_TABLES) expect(await h.tableExists(t)).toBe(true);
    expect(await snapshot()).toEqual(before);
    const me = { token: randomUUID(), executorIdentity: "executor-a" };
    const own = await acquirePublicationIntent(h.db, driver, existing.op, existing.sealId, me);
    expect(own.kind).toBe("own");
    const intents = await h.q(sql`SELECT operation_id, executor_epoch, executor_token, state FROM photo_publication_intents`);
    await h.applyWp1(); // re-initialization / re-applied migration keeps data
    expect(await h.q(sql`SELECT operation_id, executor_epoch, executor_token, state FROM photo_publication_intents`)).toEqual(intents);
    expect(await snapshot()).toEqual(before);
  });

  run("enforces structural constraints, keys and foreign keys", async () => {
    const a = await sealedOperation(), b = await sealedOperation();
    await expect(intentInsert({ operationId: randomUUID(), sealId: a.sealId })).rejects.toThrow(); // unknown operation
    await expect(intentInsert({ operationId: a.op.id, sealId: randomUUID() })).rejects.toThrow(); // unknown seal
    await expect(intentInsert({ operationId: a.op.id, sealId: a.sealId, state: "expired" })).rejects.toThrow();
    await expect(intentInsert({ operationId: a.op.id, sealId: a.sealId, generation: 0 })).rejects.toThrow();
    await expect(intentInsert({ operationId: a.op.id, sealId: a.sealId, epoch: 0 })).rejects.toThrow();
    const token = randomUUID();
    await intentInsert({ operationId: a.op.id, sealId: a.sealId, token });
    await expect(intentInsert({ operationId: a.op.id, sealId: b.sealId })).rejects.toThrow(); // one intent per operation
    await expect(intentInsert({ operationId: b.op.id, sealId: a.sealId })).rejects.toThrow(); // one intent per seal
    await expect(intentInsert({ operationId: b.op.id, sealId: b.sealId, token })).rejects.toThrow(); // one operation per token
    const exit = (operationId: string, epoch: number) => tx(() => persistAuthenticatedExecutorExitSteps(driver, { operationId, epoch, executorIdentity: "executor-x", attestedBy: "trusted" }));
    await expect(exit(b.op.id, 1)).rejects.toThrow(); // no intent
    await exit(a.op.id, 1);
    await expect(exit(a.op.id, 1)).rejects.toThrow(); // one record per epoch
    await expect(exit(a.op.id, 0)).rejects.toThrow();
  });

  run("runtime decisions: non-expiring intent blocks reclaim; transfer needs the exact exit record; fence binds the epoch", async () => {
    const s = await sealedOperation();
    const a = { token: randomUUID(), executorIdentity: "executor-a" }, b = { token: randomUUID(), executorIdentity: "executor-b" };
    const first = await acquirePublicationIntent(h.db, driver, s.op, s.sealId, a);
    if (first.kind !== "own") throw new Error("expected own");
    expect((await acquirePublicationIntent(h.db, driver, s.op, s.sealId, b)).kind).toBe("held-by-other");
    expect((await acquirePublicationIntent(h.db, driver, s.op, s.sealId, { ...a, executorIdentity: "impostor" })).kind).toBe("held-by-other");
    await expire(s.op.id);
    expect((await tx(() => guardedReclaimSteps(driver, s.op.id, PHOTO_OPERATION_LEASE_MS))).kind).toBe("in-progress");
    expect((await tx(() => transferPublicationAuthoritySteps(driver, s.op.id, 1, b))).kind).toBe("no-exit-record");
    await tx(() => persistAuthenticatedExecutorExitSteps(driver, { operationId: s.op.id, epoch: 1, executorIdentity: "someone-else", attestedBy: "trusted" }));
    expect((await tx(() => transferPublicationAuthoritySteps(driver, s.op.id, 1, b))).kind).toBe("no-exit-record"); // wrong identity
    // One record per epoch: a mismatching record cannot be replaced, so this operation stays BLOCKED (fail closed).
    await expect(tx(() => persistAuthenticatedExecutorExitSteps(driver, { operationId: s.op.id, epoch: 1, executorIdentity: "executor-a", attestedBy: "trusted" }))).rejects.toThrow();
    expect((await tx(() => transferPublicationAuthoritySteps(driver, s.op.id, 1, b))).kind).toBe("no-exit-record");
    expect((await tx(() => transferPublicationAuthoritySteps(driver, s.op.id, 2, b))).kind).toBe("lost");

    const t = await sealedOperation();
    const c = { token: randomUUID(), executorIdentity: "executor-a" }, d = { token: randomUUID(), executorIdentity: "executor-b" }; // tokens are single-operation
    const ta = await acquirePublicationIntent(h.db, driver, t.op, t.sealId, c);
    if (ta.kind !== "own") throw new Error("expected own");
    await tx(() => persistAuthenticatedExecutorExitSteps(driver, { operationId: t.op.id, epoch: 1, executorIdentity: "executor-a", attestedBy: "trusted" }));
    const moved = await tx(() => transferPublicationAuthoritySteps(driver, t.op.id, 1, d));
    if (moved.kind !== "own") throw new Error("expected transfer");
    expect([moved.authority.epoch, moved.authority.executorIdentity]).toEqual([2, "executor-b"]);
    expect((await tx(() => transferPublicationAuthoritySteps(driver, t.op.id, 1, { token: randomUUID(), executorIdentity: "executor-c" }))).kind).toBe("lost");
    await expire(t.op.id);
    const commit = (authority: PublicationAuthority) => {
      const proof = { authority, photoId: t.op.photoId, eventId: randomUUID() };
      return driver === "sqlite"
        ? Promise.resolve().then(() => h.db.transaction((x: any) => { commitIntentAuthorizedPhotoOperation(x, "synchronous", proof); }))
        : h.db.transaction(async (x: any) => { await commitIntentAuthorizedPhotoOperation(x, "asynchronous", proof); });
    };
    await expect(commit(ta.authority)).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST"); // epoch-1 authority is stale
    expect((await h.q(sql`SELECT state FROM photo_operations WHERE id = ${t.op.id}`))[0].state).toBe("sealed");
    await commit(moved.authority); // expired, unrenewed lease: the intent, not the lease, authorizes
    expect((await h.q(sql`SELECT state FROM photo_operations WHERE id = ${t.op.id}`))[0].state).toBe("committed");
    expect((await h.q(sql`SELECT state FROM photo_operation_generations WHERE operation_id = ${t.op.id}`))[0].state).toBe("committed");
    expect((await h.q(sql`SELECT state, executor_epoch FROM photo_publication_intents WHERE operation_id = ${t.op.id}`)).map((r) => [r.state, String(r.executor_epoch)])).toEqual([["committed", "2"]]);
    await expect(commit(moved.authority)).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST"); // exactly once
  });

  run("an out-of-range epoch fails closed instead of being rounded (stored, expected or next)", async () => {
    const s = await sealedOperation();
    const token = randomUUID();
    await intentInsert({ operationId: s.op.id, sealId: s.sealId, generation: 1, epoch: "9007199254740993", token });
    const op = { ...s.op, owner: "owner", nonce: "nonce" };
    await expect(Promise.resolve().then(() => acquirePublicationIntent(h.db, driver, op, s.sealId, { token, executorIdentity: "executor-x" }))).rejects.toThrow("PHOTO_PUBLICATION_INTEGER_INVALID");
    // SQLite's driver reads 9007199254740993 as 9007199254740992; neither value may be treated as equal or exact.
    for (const expected of [9007199254740992, 9007199254740991, 1])
      await expect(tx(() => transferPublicationAuthoritySteps(driver, s.op.id, expected, { token: randomUUID(), executorIdentity: "y" }))).rejects.toThrow("PHOTO_PUBLICATION_INTEGER_INVALID");
    await expect(tx(() => persistAuthenticatedExecutorExitSteps(driver, { operationId: s.op.id, epoch: 9007199254740992, executorIdentity: "y", attestedBy: "trusted" }))).rejects.toThrow("PHOTO_PUBLICATION_INTEGER_INVALID");
  });

  run("forward-only recovery: with no intent rows the tables are inert and the existing claim path behaves as before", async () => {
    const s = await sealedOperation();
    await expire(s.op.id);
    const claim = await tx(() => claimExistingOperation(driver, s.op.id, PHOTO_OPERATION_LEASE_MS));
    expect(claim.kind).toBe("owned");
    expect(String((await h.q(sql`SELECT generation FROM photo_operations WHERE id = ${s.op.id}`))[0].generation)).toBe("2");
    expect((await h.q(sql`SELECT COUNT(*) AS n FROM photo_publication_intents WHERE operation_id = ${s.op.id}`)).map((r) => Number(r.n))).toEqual([0]);
  });
});
