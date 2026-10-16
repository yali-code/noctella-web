import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";

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
