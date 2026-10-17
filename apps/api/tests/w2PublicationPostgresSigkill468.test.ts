/** #468: real PostgreSQL plus real W2 process death at each publication boundary. Synthetic media only. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { sql, type SQL } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";
const { root } = vi.hoisted(() => {
  const fs = require("node:fs"), p = require("node:path"), os = require("node:os");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "noctella-pg-kill-468-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DIR: p.join(root, "photos"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" });
  return { root };
});
import { createPostgresTestDb, postgresTestConfigured, type PostgresTestDb } from "./postgresTestDb";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
let harness: PostgresTestDb, productId: string, input: Buffer;
const q = async (s: SQL): Promise<any[]> => (await harness.db.execute(s)).rows;
const op = async (token: string) => (await q(sql`SELECT id, state, generation, main_key, thumb_key, target_photo_id, committed_photo_id FROM photo_operations WHERE subject_id = ${token}`))[0];
const effects = async (id: string) => [Number((await q(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id = ${id}`))[0].n), Number((await q(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ${id}`))[0].n)];
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("required PostgreSQL SIGKILL coverage is configured", () => expect(postgresTestConfigured).toBe(true));
beforeAll(async () => {
  if (!postgresTestConfigured) return;
  process.env.DATABASE_DRIVER = "postgres";
  process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
  harness = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
  const categoryId = randomUUID(); productId = randomUUID();
  await q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, 'PG SIGKILL 468', ${"kill-" + categoryId}) RETURNING id`);
  await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"PG-KILL-" + productId}, 'Synthetic', ${"kill-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
  input = await sharp({ create: { width: 140, height: 90, channels: 3, background: "#805020" } }).jpeg().toBuffer();
});
afterAll(async () => {
  await harness?.close();
  if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
  if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
async function recover(token: string) {
  const workDir = await mkdtemp(path.join(root, "retry-"));
  try {
    await writeFile(path.join(workDir, "input"), input);
    const file = { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal };
    return await uploadFencedProductPhoto(harness.db as any, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver: "postgres", canonicalRoot: path.join(root, "photos") });
  } finally { await rm(workDir, { recursive: true, force: true }); }
}
it.skipIf(!postgresTestConfigured).each(["beforeSeal", "afterSeal", "afterPublish", "afterCommit"] as const)("PostgreSQL SIGKILL %s recovers exactly once without overwrite", async (stage) => {
  const token = "pg-kill-" + stage + "-" + randomUUID().slice(0, 12);
  const workDir = await mkdtemp(path.join(root, "child-"));
  const url = new URL(process.env.POSTGRES_TEST_DATABASE_URL!);
  url.searchParams.set("options", "-c search_path=" + harness.schemaName);
  const child = fork(path.join(__dirname, "fixtures", "w2SigkillChild.ts"), [], {
    execArgv: ["--import", "tsx"], cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, DATABASE_DRIVER: "postgres", DATABASE_URL: url.toString(), F5_DRIVER: "postgres", F5_KILL_STAGE: stage, F5_TOKEN: token, F5_PRODUCT_ID: productId, F5_WORK_DIR: workDir, F5_INPUT_BASE64: input.toString("base64"), MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "test-468", ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000" },
  });
  let log = ""; child.stdout?.on("data", d => { log += d; }); child.stderr?.on("data", d => { log += d; });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("child park timeout: " + log.slice(-2000))), 60_000);
      child.once("message", m => resolve(String(m)));
      child.once("exit", () => reject(new Error("child exited before parking: " + log.slice(-2000))));
      child.once("error", reject);
    });
    expect(message).toBe("at:" + stage);
    expect(child.kill("SIGKILL")).toBe(true); await exited;
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  const killed = await op(token);
  expect(killed.state).toBe(stage === "beforeSeal" ? "preparing" : stage === "afterCommit" ? "committed" : "sealed");
  expect(await effects(killed.target_photo_id)).toEqual(stage === "afterCommit" ? [1, 1] : [0, 0]);
  const canonical = path.join(root, "photos", killed.main_key);
  const published = stage === "afterPublish" || stage === "afterCommit";
  const before = published ? await lstat(canonical, { bigint: true }) : null;
  if (!published) await expect(lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  if (stage !== "afterCommit") {
    await expect(recover(token)).rejects.toMatchObject({ code: "PHOTO_OPERATION_IN_PROGRESS" });
    await q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE id = ${killed.id} RETURNING id`);
  }
  const photo = await recover(token);
  expect(photo.id).toBe(killed.target_photo_id);
  expect((await op(token)).state).toBe("committed");
  expect(Number((await op(token)).generation)).toBe(stage === "afterCommit" ? 1 : 2);
  expect(await effects(photo.id)).toEqual([1, 1]);
  if (before) expect((await lstat(canonical, { bigint: true })).ino).toBe(before.ino);
  expect((await recover(token)).id).toBe(photo.id);
  expect(await effects(photo.id)).toEqual([1, 1]);
});
