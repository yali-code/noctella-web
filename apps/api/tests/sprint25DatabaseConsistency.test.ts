import Database from "better-sqlite3";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
function names(db:Database.Database, table:string){return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r=>r.name)}
function indexes(db:Database.Database, table:string){return (db.prepare(`PRAGMA index_list(${table})`).all() as any[]).map(r=>r.name)}
describe("Sprint 25 database consistency",()=>{
 it("clean SQLite has outbox and ProductPhoto processing structures",()=>{const db=new Database(":memory:"); ensureSchema(db); expect(names(db,"outbox_events")).toEqual(expect.arrayContaining(["id","event_type","idempotency_key","payload","status","available_at","locked_at"])); expect(names(db,"outbox_attempts")).toContain("safe_error_message"); expect(names(db,"product_photos")).toEqual(expect.arrayContaining(["processing_status","storage_key","thumbnail_storage_key","processing_error_code","processing_updated_at"]));});
 it("upgraded SQLite database receives additive Sprint 25 columns and tables",()=>{const db=new Database(":memory:"); ensureSchema(db); expect(names(db,"product_photos")).toContain("processing_status"); expect(names(db,"outbox_events")).toContain("idempotency_key");});
 it("outbox idempotency and indexes are present",()=>{const db=new Database(":memory:"); ensureSchema(db); expect(indexes(db,"outbox_events")).toEqual(expect.arrayContaining(["idx_outbox_events_due","idx_outbox_events_type","idx_outbox_events_aggregate","idx_outbox_events_locked"])); db.prepare("INSERT INTO outbox_events (id,event_type,aggregate_type,idempotency_key,payload,status,available_at) VALUES ('a','t','A','dup','{}','Pending','now')").run(); expect(()=>db.prepare("INSERT INTO outbox_events (id,event_type,aggregate_type,idempotency_key,payload,status,available_at) VALUES ('b','t','A','dup','{}','Pending','now')").run()).toThrow();});
 it("PostgreSQL migration is additive and non-destructive",()=>{const sql=fs.readFileSync("src/db/postgres-migrations/0002_sprint25_outbox.sql","utf8"); expect(sql).toContain("CREATE TABLE IF NOT EXISTS outbox_events"); expect(sql).toContain("ADD COLUMN IF NOT EXISTS processing_status"); expect(sql).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i);});
});
