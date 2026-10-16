import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { claimPostgresW2UploadIntent, claimSqliteW2UploadIntent, type W2UploadIntent } from "../src/services/w2OperationIdentity";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const handles: Database.Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
const open = () => { const db = new Database(":memory:"); handles.push(db); db.pragma("foreign_keys = ON"); ensureSchema(db); return db; };
const intent = { token: "repeatable_token_123", tenant: "tenant1", actor: "admin1", product: "product1", digest: "a".repeat(64), alt: "Front" };
const insert = (db: Database.Database, x = intent) =>
  db.prepare("INSERT INTO photo_w2_upload_intents(token,tenant_id,actor_id,product_id,input_sha256,alt_text,created_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(x.token, x.tenant, x.actor, x.product, x.digest, x.alt, 123);

it("registers the additive W2 table idempotently without existing product changes", () => {
  const db = open();
  ensureSchema(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='photo_w2_upload_intents'").get()).toEqual({name:"photo_w2_upload_intents"});
  expect(db.prepare("SELECT COUNT(*) AS count FROM product_photos").get()).toEqual({count:0});
});
it("one token has one durable binding; conflicting cross-tenant reclaims cannot overwrite intent", () => {
  const db = open();
  expect(insert(db).changes).toBe(1);
  expect(insert(db).changes).toBe(0);
  expect(insert(db, {...intent, tenant:"tenant2", digest:"b".repeat(64)}).changes).toBe(0);
  const row = db.prepare("SELECT tenant_id,actor_id,product_id,input_sha256,alt_text FROM photo_w2_upload_intents WHERE token=?").get(intent.token);
  expect(row).toEqual({tenant_id:intent.tenant,actor_id:intent.actor,product_id:intent.product,input_sha256:intent.digest,alt_text:intent.alt});
  expect(db.prepare("SELECT COUNT(*) AS count FROM photo_w2_upload_intents").get()).toEqual({count:1});
});
it("rejects invalid structural rows and binding to an unknown ownership operation", () => {
  const db = open();
  expect(() => insert(db,{...intent,token:"short"})).toThrow();
  expect(() => insert(db,{...intent,digest:"short"})).toThrow();
  expect(() => insert(db,{...intent,alt:"x".repeat(501)})).toThrow();
  insert(db);
  expect(() => db.prepare("UPDATE photo_w2_upload_intents SET operation_id=? WHERE token=?").run("missing-operation",intent.token)).toThrow();
});
it("keeps PostgreSQL additive DDL aligned with the SQLite token identity contract", () => {
  const sql = fs.readFileSync(path.join(__dirname,"../src/db/postgres-migrations/0041_photo_w2_upload_intents.sql"),"utf8");
  for (const field of ["token TEXT PRIMARY KEY","tenant_id TEXT NOT NULL","actor_id TEXT NOT NULL","product_id TEXT NOT NULL","input_sha256 TEXT NOT NULL","alt_text TEXT NOT NULL","operation_id TEXT UNIQUE REFERENCES photo_operations(id)"]) {
    expect(sql).toContain(field);
  }
});

it("atomically claims a validated SQLite W2 token and classifies retries without overwriting scope", () => {
  const db = open();
  const incoming: W2UploadIntent = {
    kind: "W2_PRODUCT_PHOTO_UPLOAD", token: intent.token,
    tenantId: intent.tenant, actorId: intent.actor, productId: intent.product,
    sha256: intent.digest, altText: intent.alt,
  };
  expect(claimSqliteW2UploadIntent(db, incoming, 123)).toBe("NEW");
  expect(claimSqliteW2UploadIntent(db, { ...incoming }, 124)).toBe("SAME_INTENT");
  for (const changed of [
    { ...incoming, tenantId: "other-tenant" },
    { ...incoming, actorId: "other-actor" },
    { ...incoming, productId: "other-product" },
    { ...incoming, sha256: "b".repeat(64) },
    { ...incoming, altText: "Changed" },
  ]) expect(claimSqliteW2UploadIntent(db, changed, 125)).toBe("CONFLICT");
  expect(claimSqliteW2UploadIntent(db, { ...incoming, token: "bad" }, 126)).toBe("INVALID");
  expect(claimSqliteW2UploadIntent(db, incoming, -1)).toBe("INVALID");
  expect(db.prepare("SELECT COUNT(*) AS n FROM photo_w2_upload_intents").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT tenant_id, actor_id, product_id, input_sha256, alt_text, created_ms FROM photo_w2_upload_intents WHERE token=?").get(intent.token))
    .toEqual({ tenant_id: intent.tenant, actor_id: intent.actor, product_id: intent.product,
      input_sha256: intent.digest, alt_text: intent.alt, created_ms: 123 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM photo_operations").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM product_photos").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get()).toEqual({ n: 0 });
});

it.skipIf(!postgresTestConfigured)("PostgreSQL W2 claim serializes concurrent retries and preserves immutable identity", async () => {
  const testDb = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
  const incoming: W2UploadIntent = {
    kind: "W2_PRODUCT_PHOTO_UPLOAD", token: intent.token,
    tenantId: intent.tenant, actorId: intent.actor, productId: intent.product,
    sha256: intent.digest, altText: intent.alt,
  };
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      claimPostgresW2UploadIntent(testDb.pool, incoming, 123)));
    expect(results.filter(x => x === "NEW")).toHaveLength(1);
    expect(results.filter(x => x === "SAME_INTENT")).toHaveLength(3);
    expect(await claimPostgresW2UploadIntent(testDb.pool, { ...incoming, tenantId: "tenant2" }, 124)).toBe("CONFLICT");
    expect(await claimPostgresW2UploadIntent(testDb.pool, { ...incoming, sha256: "b".repeat(64) }, 124)).toBe("CONFLICT");
    expect(await claimPostgresW2UploadIntent(testDb.pool, { ...incoming, token: "short" }, 124)).toBe("INVALID");
    const persisted = await testDb.pool.query("SELECT tenant_id, input_sha256, created_ms FROM photo_w2_upload_intents WHERE token = $1", [incoming.token]);
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].tenant_id).toBe(incoming.tenantId);
    expect(persisted.rows[0].input_sha256).toBe(incoming.sha256);
    expect(Number(persisted.rows[0].created_ms)).toBe(123);
    for (const table of ["photo_operations", "product_photos", "outbox_events"]) {
      expect((await testDb.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n).toBe("0");
    }
  } finally { await testDb.close(); }
}, 120_000);
