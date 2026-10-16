/**
 * FAZ A / #424 W11 PROPOSAL acceptance (inactive): the generation-fenced Instagram derivative owner on real SQLite
 * and (when POSTGRES_TEST_DATABASE_URL is disposable) real PostgreSQL, using the proposed 0042 DDL loaded into the
 * disposable database only. The live W11 writer must still refuse with fencing ON.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w11-fenced-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  return { root };
});

import { createTestDb } from "./testDb";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { prepareFencedInstagramDerivative, W11OperationRefusedError, type W11Hooks } from "../src/services/w11FencedInstagramDerivativeOwner";
import { prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";
import { InstagramClientError } from "../src/integrations/instagram/types";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

const proposal = readFileSync(path.resolve(__dirname, "../../../docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal"), "utf8")
  .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

it("the live W11 writer keeps refusing with ownership fencing ON (the proposal is not wired)", async () => {
  await expect(prepareInstagramImageAsset({ url: "/images/product-photos/a.webp" }, "https://api.synthetic.test", { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.synthetic.test" } as any))
    .rejects.toBeInstanceOf(InstagramClientError);
});

type Driver = "sqlite" | "postgres";
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as Array<[Driver, boolean]>)("proposed fenced W11 on %s", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {};
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const q = async (statement: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(statement) : (await db.execute(statement)).rows);
  const op = async (key: string) => (await q(sql`SELECT state, generation FROM photo_derivative_operations WHERE derivative_key = ${key}`))[0];
  const expire = () => q(sql`UPDATE photo_derivative_operations SET lease_until_ms = 0 WHERE state IN ('preparing', 'sealed') RETURNING id`);
  const webp = (r: number) => sharp({ create: { width: 300, height: 200, channels: 3, background: { r, g: 120, b: 60 } } }).webp().toBuffer();
  const prepare = (sourceKey: string, source: Buffer, hooks?: W11Hooks) => prepareFencedInstagramDerivative(db, { sourceKey, source, recipeId: "instagram-v1" }, { driver, hooks });
  const file = (key: string) => path.join(root, "photos", key);

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      process.env.DATABASE_DRIVER = "postgres";
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const harness = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
      db = harness.db; close = () => harness.close();
      for (const statement of proposal) await db.execute(sql.raw(statement));
    } else {
      delete process.env.DATABASE_DRIVER;
      db = createTestDb();
      for (const statement of proposal) db.run(sql.raw(statement));
    }
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it.skipIf(!enabled)("prepares exactly once: committed operation, valid JPEG at the content-addressed key, identical retries write nothing", async () => {
    const source = await webp(10);
    const key = await prepare(`${randomUUID()}.webp`, source);
    expect(key).toMatch(/^instagram-v1-[a-f0-9]{64}\.jpg$/);
    expect(await op(key)).toMatchObject({ state: "committed" });
    expect((await sharp(file(key)).metadata())).toMatchObject({ format: "jpeg", width: 1080, height: 1080 });
    const inode = (await lstat(file(key))).ino;
    const sourceKey = (await q(sql`SELECT source_key FROM photo_derivative_operations WHERE derivative_key = ${key}`))[0].source_key;
    expect(await prepare(sourceKey, source)).toBe(key);
    expect((await lstat(file(key))).ino).toBe(inode);
  });

  it.skipIf(!enabled)("a changed source is a different derivative and operation (no stale reuse)", async () => {
    const sourceKey = `${randomUUID()}.webp`;
    const a = await prepare(sourceKey, await webp(20)), b = await prepare(sourceKey, await webp(30));
    expect(a).not.toBe(b);
    expect([await op(a), await op(b)].map((r) => r.state)).toEqual(["committed", "committed"]);
  });

  it.skipIf(!enabled)("a stale generation cannot commit or replace the reclaiming generation's file", async () => {
    const sourceKey = `${randomUUID()}.webp`, source = await webp(40);
    let key = "", inode = 0;
    const stale = prepare(sourceKey, source, { afterSeal: async () => { await expire(); key = await prepare(sourceKey, source); inode = (await lstat(file(key))).ino; } });
    await expect(stale).rejects.toMatchObject({ code: "W11_OPERATION_FENCE_LOST" });
    expect(await op(key)).toMatchObject({ state: "committed" });
    expect(Number((await op(key)).generation)).toBe(2);
    expect((await lstat(file(key))).ino).toBe(inode);
  });

  it.skipIf(!enabled)("crash after publication keeps the evidence; a retry after lease expiry commits without replacing the file", async () => {
    const sourceKey = `${randomUUID()}.webp`, source = await webp(50);
    let key = "";
    await expect(prepare(sourceKey, source, { afterPublish: async () => { key = (await q(sql`SELECT derivative_key FROM photo_derivative_operations WHERE source_key = ${sourceKey}`))[0].derivative_key; throw new Error("crash after publish"); } })).rejects.toThrow("crash");
    expect(await op(key)).toMatchObject({ state: "sealed" });
    const inode = (await lstat(file(key))).ino;
    await expect(prepare(sourceKey, source)).rejects.toMatchObject({ code: "W11_OPERATION_IN_PROGRESS" });
    await expire();
    expect(await prepare(sourceKey, source)).toBe(key);
    expect(await op(key)).toMatchObject({ state: "committed" });
    expect((await lstat(file(key))).ino).toBe(inode);
  });

  it.skipIf(!enabled)("crash after sealing publishes nothing and recovers exactly once", async () => {
    const sourceKey = `${randomUUID()}.webp`, source = await webp(60);
    await expect(prepare(sourceKey, source, { afterSeal: () => { throw new Error("crash after seal"); } })).rejects.toThrow("crash");
    const [row] = await q(sql`SELECT derivative_key, state FROM photo_derivative_operations WHERE source_key = ${sourceKey}`);
    expect(row.state).toBe("sealed");
    await expect(lstat(file(row.derivative_key))).rejects.toMatchObject({ code: "ENOENT" });
    await expire();
    expect(await prepare(sourceKey, source)).toBe(row.derivative_key);
  });

  it.skipIf(!enabled)("a lost commit acknowledgement is answered by the committed derivative on retry", async () => {
    const sourceKey = `${randomUUID()}.webp`, source = await webp(70);
    await expect(prepare(sourceKey, source, { afterCommit: () => { throw new Error("ack lost"); } })).rejects.toThrow("ack lost");
    const [row] = await q(sql`SELECT derivative_key, state FROM photo_derivative_operations WHERE source_key = ${sourceKey}`);
    expect(row.state).toBe("committed");
    const inode = (await lstat(file(row.derivative_key))).ino;
    expect(await prepare(sourceKey, source)).toBe(row.derivative_key);
    expect((await lstat(file(row.derivative_key))).ino).toBe(inode);
  });

  it.skipIf(!enabled)("a foreign file at the derivative key is never replaced (review)", async () => {
    const sourceKey = `${randomUUID()}.webp`, source = await webp(80), foreign = Buffer.from("foreign bytes");
    let key = "";
    await expect(prepare(sourceKey, source, { afterSeal: async () => { key = (await q(sql`SELECT derivative_key FROM photo_derivative_operations WHERE source_key = ${sourceKey}`))[0].derivative_key; await writeFile(file(key), foreign, { flag: "wx" }); } }))
      .rejects.toBeInstanceOf(W11OperationRefusedError);
    expect(await op(key)).toMatchObject({ state: "review" });
    expect(await readFile(file(key))).toEqual(foreign);
  });

  it.skipIf(!enabled)("concurrent duplicates produce one committed operation and one file", async () => {
    const sourceKey = `${randomUUID()}.webp`, source = await webp(90);
    const results = await Promise.allSettled([prepare(sourceKey, source), prepare(sourceKey, source), prepare(sourceKey, source)]);
    const keys = new Set(results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<string>).value));
    expect(keys.size).toBe(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "W11_OPERATION_IN_PROGRESS" });
    expect(await q(sql`SELECT state FROM photo_derivative_operations WHERE source_key = ${sourceKey}`)).toEqual([{ state: "committed" }]);
  });
});
