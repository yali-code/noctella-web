/**
 * FAZ A / #424 Deliverable A: independent review of the proposed (INACTIVE) 0042 photo derivative schema on
 * disposable SQLite and PostgreSQL. The proposal is loaded only into these disposable databases; it is not a
 * startup or PostgreSQL migration.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-0042-review-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  return { root };
});

import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { DERIVATIVE_ROLLBACK_BLOCKERS_SQL, listW11DerivativeOperationsRequiringRecovery, prepareFencedInstagramDerivative } from "../src/services/w11FencedInstagramDerivativeOwner";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

const repo = path.resolve(__dirname, "../../..");
const proposalText = readFileSync(path.join(repo, "docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal"), "utf8");
const proposal = proposalText.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

describe("0042 proposal is inactive and order-independent (static)", () => {
  it("is not registered as a startup or PostgreSQL migration", () => {
    expect(readFileSync(path.join(repo, "apps/api/src/db/schema.sql"), "utf8")).not.toMatch(/photo_derivative_operations/);
    const migrations = readdirSync(path.join(repo, "apps/api/src/db/postgres-migrations"));
    expect(migrations.some((file) => file.startsWith("0042"))).toBe(false);
    expect(migrations.filter((file) => /photo_derivative/.test(readFileSync(path.join(repo, "apps/api/src/db/postgres-migrations", file), "utf8")))).toEqual([]);
  });
  it("is additive only and references none of 0039 / 0040 / 0041", () => {
    expect(proposalText).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/i);
    expect(proposalText.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/photo_operations\b|photo_w2_upload_intents|etsy/i);
    expect(proposal.every((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS /.test(s))).toBe(true);
  });
});

type Driver = "sqlite" | "postgres";
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as Array<[Driver, boolean]>)("0042 schema review on %s", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {};
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const q = async (s: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows);
  const apply = async () => { for (const s of proposal) { if (driver === "sqlite") db.run(sql.raw(s)); else await db.execute(sql.raw(s)); } };
  const insertOp = (over: Record<string, unknown> = {}) => {
    const v = { id: randomUUID(), kind: "instagram_derivative", key: `instagram-v1-${randomUUID()}.jpg`, fp: "a".repeat(64), state: "preparing", generation: 1, ...over };
    return q(sql`INSERT INTO photo_derivative_operations (id, kind, derivative_key, source_key, source_fingerprint, recipe, generation, owner, nonce, state, lease_until_ms, created_ms, updated_ms)
      VALUES (${v.id}, ${v.kind}, ${v.key}, 'src.webp', ${v.fp}, 'instagram-v1', ${v.generation}, 'o', ${randomUUID()}, ${v.state}, 0, 0, 0) RETURNING id`).then(() => v);
  };
  const fails = async (work: () => Promise<unknown>) => { await expect(work()).rejects.toThrow(); };

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      process.env.DATABASE_DRIVER = "postgres";
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      // Only main's latest migration (0038): proves 0042 needs nothing from 0039 / 0040 / 0041.
      const harness = await createPostgresTestDb("0038_background_job_claim_fencing.sql");
      db = harness.db; close = () => harness.close();
    } else {
      delete process.env.DATABASE_DRIVER;
      const raw = new Database(":memory:");
      raw.pragma("foreign_keys = ON");
      db = drizzle(raw); // empty database: no ensureSchema, so no 0040/0041 tables
    }
    await apply();
    await apply(); // idempotent re-application
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it.skipIf(!enabled)("enforces identity and integrity constraints", async () => {
    const ok = await insertOp();
    await fails(() => insertOp({ key: ok.key })); // derivative_key UNIQUE
    await fails(() => insertOp({ kind: "product_upload" })); // kind CHECK: only instagram_derivative
    await fails(() => insertOp({ fp: "a".repeat(63) })); // fingerprint length 64
    await fails(() => insertOp({ state: "deleted" })); // state CHECK
    await fails(() => insertOp({ generation: 0 })); // generation > 0
    const nonce = randomUUID();
    await q(sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${ok.id}, 1, 'o', ${nonce}, 'active', 0, 0) RETURNING operation_id`);
    await fails(() => q(sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${ok.id}, 2, 'o', ${nonce}, 'active', 0, 0) RETURNING operation_id`)); // nonce reuse (ABA)
    await fails(() => q(sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${ok.id}, 1, 'o', ${randomUUID()}, 'active', 0, 0) RETURNING operation_id`)); // (operation, generation) PK
    await fails(() => q(sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${randomUUID()}, 1, 'o', ${randomUUID()}, 'active', 0, 0) RETURNING operation_id`)); // FK
    await fails(() => q(sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${ok.id}, 3, 'o', ${randomUUID()}, 'gone', 0, 0) RETURNING operation_id`)); // history state CHECK
  });

  it.skipIf(!enabled)("committed derivatives whose canonical bytes changed or vanished are refused, flagged and listed; nothing is rewritten", async () => {
    const source = await sharp({ create: { width: 240, height: 160, channels: 3, background: "#406080" } }).webp().toBuffer();
    const sourceKey = `${randomUUID()}.webp`;
    const key = await prepareFencedInstagramDerivative(db, { sourceKey, source, recipeId: "instagram-v1" }, { driver });
    await writeFile(path.join(root, "photos", key), Buffer.from("tampered"));
    await expect(prepareFencedInstagramDerivative(db, { sourceKey, source, recipeId: "instagram-v1" }, { driver })).rejects.toMatchObject({ code: "W11_OPERATION_REVIEW" });
    let listed = (await listW11DerivativeOperationsRequiringRecovery(db, driver)).find((r: any) => r.derivative_key === key);
    expect(listed).toMatchObject({ state: "committed", review_reason: "committed derivative bytes changed" });
    expect(readFileSync(path.join(root, "photos", key), "utf8")).toBe("tampered");
    await unlink(path.join(root, "photos", key));
    await expect(prepareFencedInstagramDerivative(db, { sourceKey, source, recipeId: "instagram-v1" }, { driver })).rejects.toMatchObject({ code: "W11_OPERATION_REVIEW" });
    listed = (await listW11DerivativeOperationsRequiringRecovery(db, driver)).find((r: any) => r.derivative_key === key);
    expect(listed.review_reason).toBe("committed derivative missing or not a regular file");
  });

  it.skipIf(!enabled)("rollback blockers report unfinished and flagged operations; a clean table reports none", async () => {
    const blockers = await q(sql.raw(DERIVATIVE_ROLLBACK_BLOCKERS_SQL));
    expect(blockers.length).toBeGreaterThan(0); // the preparing row and the flagged committed row above
    await q(sql`DELETE FROM photo_derivative_operation_generations RETURNING operation_id`);
    await q(sql`DELETE FROM photo_derivative_operations RETURNING id`); // disposable database only
    expect(await q(sql.raw(DERIVATIVE_ROLLBACK_BLOCKERS_SQL))).toEqual([]);
  });
});
