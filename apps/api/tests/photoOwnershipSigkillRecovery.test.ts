/**
 * FAZ A #463 F5: real process death (SIGKILL / TerminateProcess), not a thrown hook exception. A child process runs
 * the live fenced W2 owner on a disposable file-backed SQLite database and is hard-killed at each stage boundary;
 * the parent then checks the durable state and recovers with the same request identity. Proves crash-consistency of
 * the database/filesystem ordering against process death only. It does NOT prove power-loss durability (no fsync is
 * exercised or required by process death; page-cache contents survive it). See FAZ_A_F3_F5_RECOVERY_CLOSURE_463.md.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import sharp from "sharp";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-f5-sigkill-"));
  Object.assign(process.env, {
    DATABASE_URL: join(root, "api.sqlite"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true",
    PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "f5-state",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
  });
  delete process.env.DATABASE_DRIVER;
  return { root };
});

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
let db: any, productId: string, input: Buffer;
const all = (statement: any) => db.all(statement) as any[];
const photos = () => path.join(root, "photos");
const privateRoot = () => path.join(root, ".product-photo-operations");

beforeAll(async () => {
  db = (await import("../src/db/client")).db;
  const category = await (await import("../src/services/categories")).createCategory(db, { name: "F5", displayOrder: 0, isActive: true });
  productId = (await (await import("../src/services/products")).createProduct(db, { sku: "F5-SIGKILL", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false } as any)).id;
  input = await sharp({ create: { width: 140, height: 90, channels: 3, background: { r: 200, g: 90, b: 40 } } }).jpeg().toBuffer();
});
afterAll(async () => { await (await import("../src/db/client")).dbRuntime.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });

/** Runs the child until it parks at `stage`, then kills it with SIGKILL and waits for the process to be gone. */
async function killAt(stage: string, token: string): Promise<void> {
  const workDir = await mkdtemp(path.join(root, "work-"));
  const child = fork(path.join(__dirname, "fixtures", "w2SigkillChild.ts"), [], {
    execArgv: ["--import", "tsx"], cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, F5_KILL_STAGE: stage, F5_TOKEN: token, F5_PRODUCT_ID: productId, F5_WORK_DIR: workDir, F5_INPUT_BASE64: input.toString("base64") },
  });
  let log = "";
  child.stdout?.on("data", (d) => { log += d; }); child.stderr?.on("data", (d) => { log += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const message = await new Promise<string>((resolve, reject) => {
    child.once("message", (m) => resolve(String(m)));
    child.once("exit", () => reject(new Error(`child exited before parking: ${log.slice(-2000)}`)));
  });
  expect(message).toBe(`at:${stage}`);
  expect(child.kill("SIGKILL")).toBe(true);
  const exit = await exited;
  expect(exit.code === 0).toBe(false); // killed, never a clean exit
}

async function recover(token: string) {
  const workDir = await mkdtemp(path.join(root, "retry-"));
  await writeFile(path.join(workDir, "input"), input);
  const file = { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal };
  const { uploadFencedProductPhoto } = await import("../src/services/w2FencedProductPhotoOwner");
  const { digestW2StagedInput } = await import("../src/services/w2StagedInputDigest");
  return uploadFencedProductPhoto(db, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver: "sqlite" });
}
const op = (token: string) => all(sql`SELECT id, state, generation, main_key, thumb_key, committed_photo_id FROM photo_operations WHERE subject_id = ${token}`)[0];
const effects = (token: string) => {
  const row = op(token);
  return [
    Number(all(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id = ${row?.committed_photo_id ?? ""}`)[0].n),
    Number(all(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ${row?.committed_photo_id ?? ""}`)[0].n),
  ];
};
const exists = (file: string) => lstat(file).then(() => true, () => false);
const expire = (token: string) => all(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE subject_id = ${token} AND state IN ('preparing', 'sealed') RETURNING id`);

it("SIGKILL before sealing: a preparing claim recovers without canonical adoption", async () => {
  const token = `f5-before-seal-${randomUUID().slice(0, 12)}`;
  await killAt("beforeSeal", token);
  const killed = op(token);
  expect(killed.state).toBe("preparing");
  expect([await exists(path.join(photos(), killed.main_key)), await exists(path.join(photos(), killed.thumb_key))]).toEqual([false, false]);
  expect(effects(token)).toEqual([0, 0]);
  expire(token);
  await recover(token);
  expect([op(token).state, Number(op(token).generation)]).toEqual(["committed", 2]);
  expect(effects(token)).toEqual([1, 1]);
});

it("SIGKILL after sealing: nothing published or committed; retry after lease expiry commits exactly once", async () => {
  const token = `f5-seal-${randomUUID().slice(0, 12)}`;
  await killAt("afterSeal", token);
  const killed = op(token);
  expect(killed.state).toBe("sealed");
  expect([await exists(path.join(photos(), killed.main_key)), await exists(path.join(photos(), killed.thumb_key))]).toEqual([false, false]);
  expect(Number(all(sql`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ${productId} AND id = ${killed.id}`)[0].n)).toBe(0);
  await expect(recover(token)).rejects.toMatchObject({ code: "PHOTO_OPERATION_IN_PROGRESS" }); // live lease of the dead owner
  expire(token);
  const photo = await recover(token);
  expect([op(token).state, Number(op(token).generation)]).toEqual(["committed", 2]);
  expect(photo.id).toBe(op(token).committed_photo_id);
  expect(effects(token)).toEqual([1, 1]);
  expect(await readdir(path.join(privateRoot(), killed.id))).toEqual(expect.arrayContaining(["1", "2"])); // dead generation's evidence retained
});

it("SIGKILL after canonical publication: the published inodes are adopted on recovery, never replaced", async () => {
  const token = `f5-pub-${randomUUID().slice(0, 12)}`;
  await killAt("afterPublish", token);
  const killed = op(token);
  expect(killed.state).toBe("sealed");
  const before = [(await lstat(path.join(photos(), killed.main_key))).ino, (await lstat(path.join(photos(), killed.thumb_key))).ino];
  expect(effects(token)).toEqual([0, 0]); // published bytes but no committed photo row or outbox event
  expire(token);
  await recover(token);
  expect([op(token).state, Number(op(token).generation)]).toEqual(["committed", 2]);
  expect(effects(token)).toEqual([1, 1]);
  expect([(await lstat(path.join(photos(), killed.main_key))).ino, (await lstat(path.join(photos(), killed.thumb_key))).ino]).toEqual(before);
});

it("SIGKILL after the SQL commit (response never delivered): the retry returns the committed photo with no new effects", async () => {
  const token = `f5-commit-${randomUUID().slice(0, 12)}`;
  await killAt("afterCommit", token);
  const killed = op(token);
  expect(killed.state).toBe("committed");
  expect(effects(token)).toEqual([1, 1]);
  const files = (await readdir(photos())).length;
  const photo = await recover(token);
  expect(photo.id).toBe(killed.committed_photo_id);
  expect(effects(token)).toEqual([1, 1]);
  expect((await readdir(photos())).length).toBe(files);
  expect(Number(op(token).generation)).toBe(1);
});
