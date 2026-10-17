/**
 * FAZ A / #424 W2 generation-fenced owner: stale writers, crash recovery, lost acknowledgement and concurrent
 * duplicates on real SQLite and (when POSTGRES_TEST_DATABASE_URL is a disposable database) real PostgreSQL.
 * Real files, real image recipe, real photo/outbox transaction with the generation CAS.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w2-owner-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  return { root };
});

import { createTestDb } from "./testDb";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";
import { listW2OperationsRequiringRecovery, uploadFencedProductPhoto, type FencedUploadHooks } from "../src/services/w2FencedProductPhotoOwner";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

// CI sets W2_LIVE_REQUIRE_POSTGRES=1: the PostgreSQL cases must actually run there, never silently skip.
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

type Driver = "sqlite" | "postgres";
const drivers: Array<[Driver, boolean]> = [["sqlite", true], ["postgres", postgresTestConfigured]];

describe.each(drivers)("W2 fenced owner on %s", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {}, productId: string, front: Buffer, back: Buffer;
  const savedDriver = process.env.DATABASE_DRIVER;
  const q = async (statement: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(statement) : (await db.execute(statement)).rows);
  const n = async (table: string, where = "") => Number((await q(sql.raw(`SELECT COUNT(*) AS n FROM ${table} ${where}`)))[0].n);
  const op = async (token: string) => (await q(sql`SELECT id, state, generation, main_key, thumb_key, target_photo_id, committed_photo_id FROM photo_operations WHERE subject_id = ${token}`))[0];
  const expire = (token: string) => q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE subject_id = ${token} RETURNING id`);
  async function upload(token: string, bytes: Buffer, hooks?: FencedUploadHooks) {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "noctella-w2-input-"));
    await writeFile(path.join(workDir, "input"), bytes);
    const file = { path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
    try {
      const sha256 = await digestW2StagedInput(file, 10 * 1024 * 1024);
      return await uploadFencedProductPhoto(db, { productId, actorId: "actor-1", operationToken: token, sha256, altText: "", file }, { driver, hooks });
    } finally { await rm(workDir, { recursive: true, force: true }); }
  }

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      process.env.DATABASE_DRIVER = "postgres";
      const harness = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
      db = harness.db; close = () => harness.close();
    } else db = createTestDb();
    if (driver === "postgres") {
      // Seed directly: the category write path is outside W2 and still passes ISO strings to PostgreSQL timestamp
      // columns (pre-existing gap, recorded separately). The W2 owner and photo/outbox transaction under test are real.
      const categoryId = randomUUID();
      productId = randomUUID();
      await q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, 'W2 postgres', ${"w2-pg-" + categoryId}) RETURNING id`);
      await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"W2-PG-" + productId}, 'Synthetic', ${"w2-pg-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
    } else {
      const category = await createCategory(db, { name: `W2 ${driver}`, displayOrder: 0, isActive: true });
      productId = (await createProduct(db, { sku: `W2-${driver}`, title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false } as any)).id;
    }
    front = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#705030" } }).jpeg().toBuffer();
    back = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#305070" } }).jpeg().toBuffer();
  });
  afterAll(async () => { await close(); if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver; });

  it.skipIf(!enabled)("a stale generation can neither commit nor overwrite the new owner's files", async () => {
    const token = `stale-${driver}-000000000001`;
    let winner: any, inode: number | undefined;
    const stale = upload(token, front, {
      afterSeal: async () => {
        await expire(token); // the first owner stalls past its lease; a retry reclaims generation 2
        winner = await upload(token, front);
        inode = (await lstat(path.join(root, "photos", (await op(token)).main_key))).ino;
      },
    });
    await expect(stale).rejects.toMatchObject({ status: 503 });
    const record = await op(token);
    expect(record).toMatchObject({ state: "committed", committed_photo_id: winner.id });
    expect(Number(record.generation)).toBe(2);
    expect(await n("product_photos", `WHERE id = '${winner.id}'`)).toBe(1);
    expect(await n("outbox_events", `WHERE aggregate_id = '${winner.id}'`)).toBe(1);
    expect((await lstat(path.join(root, "photos", record.main_key))).ino).toBe(inode);
    expect((await q(sql`SELECT state FROM photo_operation_generations WHERE operation_id = ${record.id} ORDER BY generation`)).map((r) => r.state)).toEqual(["superseded", "committed"]);
  });

  it.skipIf(!enabled)("a crash after publication keeps the evidence, is reported, and a retry recovers exactly once", async () => {
    const token = `crash-${driver}-000000000001`;
    await expect(upload(token, back, { afterPublish: () => { throw new Error("simulated crash after publish"); } })).rejects.toThrow("simulated crash");
    const sealed = await op(token);
    expect(sealed.state).toBe("sealed");
    const published = await Promise.all([sealed.main_key, sealed.thumb_key].map(async (key) => (await lstat(path.join(root, "photos", key))).ino));
    expect(await n("product_photos", `WHERE id = '${sealed.committed_photo_id ?? "none"}'`)).toBe(0);
    expect((await listW2OperationsRequiringRecovery(db, driver)).map((r: any) => r.token)).not.toContain(token); // lease still live
    await expect(upload(token, back)).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_IN_PROGRESS" });
    await expire(token);
    expect((await listW2OperationsRequiringRecovery(db, driver)).map((r: any) => r.token)).toContain(token);
    const recovered = await upload(token, back);
    const record = await op(token);
    expect(record).toMatchObject({ state: "committed", committed_photo_id: recovered.id });
    expect(await n("product_photos", `WHERE id = '${recovered.id}'`)).toBe(1);
    expect(await Promise.all([record.main_key, record.thumb_key].map(async (key) => (await lstat(path.join(root, "photos", key))).ino))).toEqual(published);
    expect((await listW2OperationsRequiringRecovery(db, driver)).map((r: any) => r.token)).not.toContain(token);
  });

  it.skipIf(!enabled)("a lost commit acknowledgement does not duplicate the photo on retry", async () => {
    const token = `ack-${driver}-0000000000001`;
    await expect(upload(token, front, { afterCommit: () => { throw new Error("acknowledgement lost"); } })).rejects.toThrow("acknowledgement lost");
    const committed = await op(token);
    expect(committed.state).toBe("committed");
    const retried = await upload(token, front);
    expect(retried.id).toBe(committed.committed_photo_id);
    expect(await n("product_photos", `WHERE id = '${retried.id}'`)).toBe(1);
    expect(await n("outbox_events", `WHERE aggregate_id = '${retried.id}'`)).toBe(1);
  });

  it.skipIf(!enabled)("concurrent duplicates of one identity produce exactly one photo", async () => {
    const token = `race-${driver}-000000000001`;
    const results = await Promise.allSettled([upload(token, back), upload(token, back), upload(token, back)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fulfilled.map((r) => r.value.id)).size).toBe(1);
    for (const r of rejected) expect(r.reason).toMatchObject({ status: 409, code: "PHOTO_OPERATION_IN_PROGRESS" });
    const record = await op(token);
    expect(record.state).toBe("committed");
    expect(await n("photo_operations", `WHERE subject_id = '${token}'`)).toBe(1);
    expect(await n("product_photos", `WHERE id = '${record.committed_photo_id}'`)).toBe(1);
  });

  it.skipIf(!enabled)("a different file at the canonical key is never overwritten: the operation goes to review, nothing commits", async () => {
    const token = `collide-${driver}-0000000001`;
    const foreign = Buffer.from("foreign bytes that must survive");
    const attempt = upload(token, front, {
      afterSeal: async () => { await writeFile(path.join(root, "photos", (await op(token)).main_key), foreign, { flag: "wx" }); },
    });
    await expect(attempt).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_REVIEW" });
    const record = await op(token);
    expect(record.state).toBe("review");
    await expect((await import("node:fs/promises")).readFile(path.join(root, "photos", record.main_key))).resolves.toEqual(foreign);
    expect(await n("product_photos", `WHERE id = '${record.committed_photo_id ?? "none"}'`)).toBe(0);
    expect((await listW2OperationsRequiringRecovery(db, driver)).map((r: any) => r.token)).toContain(token);
  });

  it.skipIf(!enabled).each(["main", "thumb"] as const)("F3: foreign identical-byte %s canonical inode is preserved and rejected", async (artifact) => {
    const token = `foreign-equal-${artifact}-${driver}-000001`;
    let destination = "", foreignInode = "", foreignBytes: Buffer;
    await expect(upload(token, front, { afterSeal: async () => {
      const record = await op(token);
      const source = path.join(root, ".product-photo-operations", record.id, String(record.generation), artifact + ".webp");
      destination = path.join(root, "photos", record[artifact + "_key"]);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      foreignBytes = await readFile(destination);
      foreignInode = String((await lstat(destination, { bigint: true })).ino);
      expect(foreignInode).not.toBe(String((await lstat(source, { bigint: true })).ino));
    } })).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_REVIEW" });
    const record = await op(token);
    expect(record.state).toBe("review");
    expect(String((await lstat(destination, { bigint: true })).ino)).toBe(foreignInode);
    expect(await readFile(destination)).toEqual(foreignBytes!);
    expect(await n("product_photos", `WHERE id = '${record.target_photo_id}'`)).toBe(0);
    expect(await n("outbox_events", `WHERE aggregate_id = '${record.target_photo_id}'`)).toBe(0);
  });

  it.skipIf(!enabled).each(["missing", "replaced"] as const)("F3: recorded prior seal with %s private name cannot authorize adoption", async (mode) => {
    const token = `orphan-${mode}-${driver}-000001`;
    await expect(upload(token, front, { afterPublish: () => { throw new Error("crash retains canonical"); } })).rejects.toThrow("crash retains canonical");
    const record = await op(token), destination = path.join(root, "photos", record.main_key);
    const before = await lstat(destination, { bigint: true });
    const privateName = path.join(root, ".product-photo-operations", record.id, "1", "main.webp");
    await rm(privateName);
    if (mode === "replaced") await copyFile(destination, privateName);
    await expire(token);
    await expect(upload(token, front)).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_REVIEW" });
    expect((await op(token)).state).toBe("review");
    expect((await lstat(destination, { bigint: true })).ino).toBe(before.ino);
    expect(await n("product_photos", `WHERE id = '${record.target_photo_id}'`)).toBe(0);
  });

  it.skipIf(!enabled)("REPRO F2 SECURITY FAIL: stale W2 A publishes while reclaimed B is sealed but has not published", async () => {
    const token = `stale-before-b-${driver}-001`;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let winner: Promise<any> | undefined, staleInode = "";
    try {
      await expect(upload(token, front, {
        afterSeal: async () => {
          await expire(token);
          let sealed!: () => void, failed!: (e: unknown) => void;
          const ready = new Promise<void>((resolve, reject) => { sealed = resolve; failed = reject; });
          winner = upload(token, front, { afterSeal: async () => { sealed(); await paused; } });
          winner.catch(failed); // observe rejection immediately, including preparation failures
          await ready;
          const record = await op(token);
          expect([Number(record.generation), record.state]).toEqual([2, "sealed"]);
          await expect(lstat(path.join(root, "photos", record.main_key))).rejects.toMatchObject({ code: "ENOENT" });
        },
        afterPublish: async () => {
          const record = await op(token);
          expect([Number(record.generation), record.state]).toEqual([2, "sealed"]);
          const privateA = await lstat(path.join(root, ".product-photo-operations", record.id, "1", "main.webp"), { bigint: true });
          const canonical = await lstat(path.join(root, "photos", record.main_key), { bigint: true });
          expect([canonical.dev, canonical.ino]).toEqual([privateA.dev, privateA.ino]);
          expect(await n("product_photos", `WHERE id = '${record.target_photo_id}'`)).toBe(0);
          expect(await n("outbox_events", `WHERE aggregate_id = '${record.target_photo_id}'`)).toBe(0);
          staleInode = String(canonical.ino); // vulnerability: stale actor successfully linked before final CAS
        },
      })).rejects.toMatchObject({ status: 503 });
      expect(staleInode).not.toBe("");
      release();
      const recovered = await winner!;
      const record = await op(token);
      expect([Number(record.generation), record.state]).toEqual([2, "committed"]);
      expect(String((await lstat(path.join(root, "photos", record.main_key), { bigint: true })).ino)).toBe(staleInode);
      expect(await n("product_photos", `WHERE id = '${recovered.id}'`)).toBe(1);
      expect(await n("outbox_events", `WHERE aggregate_id = '${recovered.id}'`)).toBe(1);
    } finally { release(); if (winner) await winner.catch(() => undefined); }
  });

  it.skipIf(!enabled)("private generation evidence never lives under the public static root", async () => {
    expect(await readdir(path.join(root, "photos"))).not.toContain(".product-photo-operations");
    expect((await readdir(root))).toContain(".product-photo-operations");
  });
});
