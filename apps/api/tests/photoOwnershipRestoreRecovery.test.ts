/**
 * FAZ A #424 gate 5: fenced W2 recovery after a database + photo restore (disposable SQLite only).
 *
 * Restore model, as the product implements it: `db:backup` snapshots the SQLite file with better-sqlite3's online
 * backup (services/databaseBackup.ts sqliteSource), and photo backups copy canonical BYTES of referenced photos
 * (product-photo-backup), so restored canonical files are new inodes and the private generation directories
 * (`.product-photo-operations`) are NOT restored. Database backup/restore is SQLite-only in this application.
 * Each restore runs in its own isolated root with its own database file; nothing touches the source environment.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-gate5-restore-"));
  Object.assign(process.env, {
    DATABASE_URL: join(root, "api.sqlite"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true",
    PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "gate5-state",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
  });
  delete process.env.DATABASE_DRIVER;
  return { root };
});

import * as sqliteSchema from "../src/db/schema.sqlite";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let db: any, productId: string, input: Buffer;
const opened: Database.Database[] = [];

beforeAll(async () => {
  db = (await import("../src/db/client")).db;
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "Gate5", displayOrder: 0, isActive: true });
  productId = (await (await import("../src/services/products")).createProduct(db, { sku: "GATE5-RESTORE", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false } as any)).id;
  input = await sharp({ create: { width: 130, height: 85, channels: 3, background: { r: 60, g: 170, b: 120 } } }).jpeg().toBuffer();
});
afterAll(async () => {
  for (const handle of opened) handle.close();
  await (await import("../src/db/client")).dbRuntime.shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The same online-backup primitive db:backup uses (services/databaseBackup.ts sqliteSource). */
async function snapshot(): Promise<string> {
  const file = path.join(root, `snapshot-${randomUUID()}.sqlite`);
  await (db as any).$client.backup(file);
  return file;
}

/** Restores a snapshot plus copies of the given canonical files into a fresh isolated root (new inodes, no private dirs). */
async function restore(snapshotFile: string, canonicalFiles: string[] = []) {
  const restoreRoot = await mkdtemp(path.join(root, "restore-"));
  const dbFile = path.join(restoreRoot, "api.sqlite"), photos = path.join(restoreRoot, "photos");
  await copyFile(snapshotFile, dbFile);
  await mkdir(photos, { recursive: true });
  for (const file of canonicalFiles) await copyFile(path.join(root, "photos", file), path.join(photos, file));
  const sqlite = new Database(dbFile); opened.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  return { restoreRoot, photos, sqlite, db: drizzle(sqlite, { schema: sqliteSchema }) };
}

function uploader(target: any, token: string, canonicalRoot?: string) {
  return async (hooks?: any) => {
    const workDir = await mkdtemp(path.join(root, "work-"));
    await writeFile(path.join(workDir, "input"), input);
    const file = { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal };
    return uploadFencedProductPhoto(target, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver: "sqlite", hooks, ...(canonicalRoot ? { canonicalRoot } : {}) });
  };
}
const op = (target: any, token: string) => (target.all(sql`SELECT id, state, generation, main_key, thumb_key, committed_photo_id, review_reason FROM photo_operations WHERE subject_id = ${token}`) as any[])[0];
const photosOf = (target: any) => Number((target.all(sql`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ${productId}`) as any[])[0].n);
const eventsFor = (target: any, photoId: string | null) => Number((target.all(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ${photoId ?? ""}`) as any[])[0].n);
const expire = (target: any, token: string) => target.all(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE subject_id = ${token} AND state IN ('preparing', 'sealed') RETURNING id`);
const exists = (file: string) => lstat(file).then(() => true, () => false);

it("a restored database is structurally sound: integrity_check ok, no foreign-key violations, ownership tables and intents present", async () => {
  const token = `gate5-sound-${randomUUID().slice(0, 12)}`;
  await uploader(db, token)();
  const restored = await restore(await snapshot());
  expect(restored.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(restored.sqlite.pragma("foreign_key_check")).toEqual([]);
  for (const table of ["photo_operations", "photo_operation_generations", "photo_operation_artifacts", "photo_w2_upload_intents"])
    expect(restored.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
  expect(op(restored.db, token).state).toBe("committed");
  expect(Number((restored.db.all(sql`SELECT COUNT(*) AS n FROM photo_w2_upload_intents WHERE token = ${token}`) as any[])[0].n)).toBe(1);
  // Gate 6 "stable single-tenant scope": persisted intents carry the fixed scope. Changing it would make every
  // retry of an already-stored key (including after a restore or deploy) an idempotency CONFLICT.
  expect((restored.db.all(sql`SELECT tenant_id FROM photo_w2_upload_intents WHERE token = ${token}`) as any[])[0].tenant_id).toBe("noctella");
});

it("restore of a mid-operation (sealed) snapshot without private files: the retry recovers exactly once after the lease expires", async () => {
  const token = `gate5-sealed-${randomUUID().slice(0, 12)}`;
  let snap = "";
  await expect(uploader(db, token)({ afterSeal: async () => { snap = await snapshot(); throw new Error("process lost after seal"); } })).rejects.toThrow("process lost");
  const restored = await restore(snap); // nothing was committed, so a photo backup holds nothing for it
  const before = op(restored.db, token);
  expect(before.state).toBe("sealed");
  expect(await exists(path.join(restored.restoreRoot, ".product-photo-operations"))).toBe(false); // private evidence is not restored
  const retry = uploader(restored.db, token, restored.photos);
  const photosBefore = photosOf(restored.db);
  await expect(retry()).rejects.toMatchObject({ code: "PHOTO_OPERATION_IN_PROGRESS" }); // the restored lease is still honoured
  expire(restored.db, token);
  const photo = await retry();
  const after = op(restored.db, token);
  expect([after.state, Number(after.generation)]).toEqual(["committed", 2]);
  expect(photo.id).toBe(after.committed_photo_id);
  expect(photosOf(restored.db)).toBe(photosBefore + 1); // exactly one new photo
  expect(eventsFor(restored.db, after.committed_photo_id)).toBe(1); // exactly one outbox event
  expect(Number((restored.db.all(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id = ${after.committed_photo_id}`) as any[])[0].n)).toBe(1);
  expect((await readdir(restored.photos)).sort()).toEqual([after.main_key, after.thumb_key].sort());
});

it("a photo backup NEWER than the database snapshot: restored same-bytes canonical copies are not adoptable, so the operation goes to review without overwrite", async () => {
  const token = `gate5-skew-${randomUUID().slice(0, 12)}`;
  let snap = "";
  await uploader(db, token)({ afterSeal: async () => { snap = await snapshot(); } }); // the source then commits normally
  const committed = op(db, token);
  expect(committed.state).toBe("committed");
  // Database restored from the earlier (sealed) snapshot; photos restored from the later backup (byte copies).
  const restored = await restore(snap, [committed.main_key, committed.thumb_key]);
  const restoredMain = path.join(restored.photos, committed.main_key);
  const [bytesBefore, inodeBefore] = [await readFile(restoredMain), (await lstat(restoredMain)).ino];
  expect(op(restored.db, token).state).toBe("sealed");
  expire(restored.db, token);
  // F3: the copy carries the right bytes but no live private name of this operation holds its inode, so it is
  // indistinguishable from a foreign file. Fail closed: review, never adopt, never replace.
  await expect(uploader(restored.db, token, restored.photos)()).rejects.toMatchObject({ code: "PHOTO_OPERATION_REVIEW" });
  const after = op(restored.db, token);
  expect(after.state).toBe("review");
  expect(after.review_reason).toBe("REVIEW_FOREIGN_SAME_BYTES");
  expect(Number((restored.db.all(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id = ${committed.committed_photo_id}`) as any[])[0].n)).toBe(0);
  expect(await readFile(restoredMain)).toEqual(bytesBefore);
  expect((await lstat(restoredMain)).ino).toBe(inodeBefore);
});

it("restore of a committed snapshot with its photo backup: the retry returns the committed photo with no new rows or files", async () => {
  const token = `gate5-committed-${randomUUID().slice(0, 12)}`;
  const original = await uploader(db, token)();
  const committed = op(db, token);
  const restored = await restore(await snapshot(), [committed.main_key, committed.thumb_key]);
  const files = (await readdir(restored.photos)).sort();
  const photosBefore = photosOf(restored.db);
  const again = await uploader(restored.db, token, restored.photos)();
  expect(again.id).toBe(original.id);
  expect(photosOf(restored.db)).toBe(photosBefore);
  expect(eventsFor(restored.db, original.id)).toBe(1);
  expect((await readdir(restored.photos)).sort()).toEqual(files);
  expect(Number(op(restored.db, token).generation)).toBe(1);
});
