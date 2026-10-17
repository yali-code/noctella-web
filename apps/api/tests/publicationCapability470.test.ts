/** #470 OFFLINE capability proof. Real owners/DBs; no runtime broker or deployment integration. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import sharp from "sharp";
import { ProductStatus, ProductType } from "@noctella/shared";
const { root } = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "noctella-capability-470-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DIR: p.join(root, "canonical"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" });
  return { root };
});
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";
import { buildFencedAiIntakePhotoFinalizationManifest } from "../src/services/w4FencedFinalizationOwner";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const launcher = process.env.F2_CAPABILITY_LAUNCHER;
const native = process.platform === "linux" && !!launcher;
const canonical = path.join(root, "canonical"), privateRoot = path.join(root, ".product-photo-operations");
it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required unprivileged Linux capability and PostgreSQL proof is configured", () => {
  expect(process.platform).toBe("linux"); expect(launcher).toBeTruthy(); expect(process.getuid?.()).not.toBe(0); expect(postgresTestConfigured).toBe(true);
});
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
it.skipIf(!native)("LIMIT: writable private hardlink alias can mutate canonical; producer revocation is mandatory", async () => {
  const work = await mkdtemp(path.join(root, "alias-limit-"));
  const denied = await mkdtemp(path.join(root, "canonical-limit-"));
  const privateName = path.join(work, "private.webp"), canonicalName = path.join(denied, "canonical.webp");
  await writeFile(privateName, "sealed-before-handoff"); await link(privateName, canonicalName);
  const proc = spawn(launcher!, [work, "--", process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'changed-via-private-alias')", privateName], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; proc.stderr?.on("data", d => { log += d; });
  const exit = new Promise<number | null>((resolve, reject) => { proc.once("exit", resolve); proc.once("error", reject); });
  try { expect(await bounded(exit, "alias limit fixture")).toBe(0); }
  finally { if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGKILL"); await exit; } }
  expect(log).toContain("LANDLOCK_ENFORCED");
  expect(await readFile(canonicalName, "utf8")).toBe("changed-via-private-alias"); // LIMIT, not security PASS
});
async function bounded<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("BLOCKED: " + label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function afterRevocation<T>(revoked: Promise<void>, start: () => T | Promise<T>, ms = 5000): Promise<T> {
  await bounded(revoked, "revocation not proven", ms);
  return start();
}
it("REFUSED offline: failed or timed-out revocation cannot release a publisher", async () => {
  let released = false;
  const release = () => { released = true; };
  await expect(afterRevocation(Promise.reject(new Error("revocation failed")), release)).rejects.toThrow("revocation failed");
  expect(released).toBe(false);
  await expect(afterRevocation(new Promise<void>(() => {}), release, 25)).rejects.toThrow("BLOCKED: revocation not proven");
  expect(released).toBe(false);
});
function deferred<T = void>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("OFFLINE capability on %s", (driver, configured) => {
  let db: any, raw: Database.Database | undefined, close = async () => {}, productId: string, input: Buffer, childUrl: string;
  const dbDir = path.join(root, driver + "-db");
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const q = async (s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;
  const op = async (token: string) => (await q(sql`SELECT id, generation, state, main_key, thumb_key, target_photo_id FROM photo_operations WHERE subject_id=${token}`))[0];
  beforeAll(async () => {
    if (!native || !configured) return;
    await Promise.all([mkdir(dbDir, { recursive: true }), mkdir(canonical, { recursive: true }), mkdir(privateRoot, { recursive: true })]);
    process.env.DATABASE_DRIVER = driver;
    if (driver === "postgres") {
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const h = await createPostgresTestDb("0041_photo_w2_upload_intents.sql"); db = h.db; close = () => h.close();
      const url = new URL(process.env.POSTGRES_TEST_DATABASE_URL!); url.searchParams.set("options", "-c search_path=" + h.schemaName); childUrl = url.toString();
    } else {
      childUrl = path.join(dbDir, "test.sqlite"); process.env.DATABASE_URL = childUrl;
      raw = new Database(childUrl); raw.pragma("journal_mode=WAL"); raw.pragma("foreign_keys=ON"); ensureSchema(raw); db = drizzle(raw, { schema }); close = async () => { raw!.close(); };
    }
    const category = randomUUID(); productId = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${category}, 'Capability 470', ${"cap-" + category}) RETURNING id`);
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"CAP-" + productId}, 'Synthetic', ${"cap-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${category}) RETURNING id`);
    input = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#805030" } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });
  async function upload(kind: "w2" | "w4", token: string, afterSeal?: () => Promise<void>) {
    if (kind === "w4") return buildFencedAiIntakePhotoFinalizationManifest(db, async () => input, [{ id: token, storageKey: "synthetic.webp" }] as any, productId, undefined, { driver, canonicalRoot: canonical, hooks: { afterSeal } });
    const workDir = await mkdtemp(path.join(root, "parent-"));
    try {
      await writeFile(path.join(workDir, "input"), input);
      const file = { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal };
      return await uploadFencedProductPhoto(db, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver, canonicalRoot: canonical, hooks: { afterSeal } });
    } finally { await rm(workDir, { recursive: true, force: true }); }
  }
  async function child(kind: "w2" | "w4", token: string, confined: boolean) {
    const work = await mkdtemp(path.join(root, "child-"));
    const nodeArgs = ["--import", "tsx", path.join(__dirname, "fixtures", "publicationCapabilityChild470.ts")];
    const proc = spawn(confined ? launcher! : process.execPath, confined ? [privateRoot, work, dbDir, "--", process.execPath, ...nodeArgs] : nodeArgs, {
      cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, DATABASE_DRIVER: driver, DATABASE_URL: childUrl, TMPDIR: work, F470_DRIVER: driver, F470_KIND: kind, F470_TOKEN: token, F470_PRODUCT: productId, F470_WORK: work, F470_INPUT: input.toString("base64"), MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "test-470", ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000" },
    });
    let log = ""; proc.stdout?.on("data", d => { log += d; }); proc.stderr?.on("data", d => { log += d; });
    const exit = new Promise<void>(resolve => proc.once("exit", () => resolve()));
    const message = () => bounded(new Promise<any>((resolve, reject) => {
      const onMessage = (m: any) => { cleanup(); resolve(m); }, onExit = () => { cleanup(); reject(new Error("child exited: " + log.slice(-2000))); }, onError = (e: Error) => { cleanup(); reject(e); };
      const cleanup = () => { proc.off("message", onMessage); proc.off("exit", onExit); proc.off("error", onError); };
      proc.once("message", onMessage); proc.once("exit", onExit); proc.once("error", onError);
    }), "worker acknowledgement " + log.slice(-1000));
    const kill = async () => { if (proc.exitCode === null && proc.signalCode === null) expect(proc.kill("SIGKILL")).toBe(true); await bounded(exit, "old process revocation", 5000); };
    return { proc, message, kill, log: () => log };
  }
  describe.each(["w2", "w4"] as const)("%s", kind => {
    it.skipIf(!native || !configured).each(["resume", "close-db-and-resume"])("PREVENTED offline: confined A→B→A %s cannot link; trusted test authority progresses", async command => {
      const token = randomUUID(), a = await child(kind, token, true);
      const release = deferred(), ready = deferred(); let b: Promise<any> | undefined;
      try {
        expect(await a.message()).toEqual({ event: "sealed", uid: process.getuid?.() });
        expect(a.log()).toContain("LANDLOCK_ENFORCED");
        await q(sql`UPDATE photo_operations SET lease_until_ms=0 WHERE subject_id=${token} RETURNING id`);
        b = upload(kind, token, async () => { ready.resolve(); await release.promise; }); b.catch(ready.reject); await bounded(ready.promise, "replacement sealing");
        const row = await op(token); expect([Number(row.generation), row.state]).toEqual([2, "sealed"]);
        const denied = a.message(); a.proc.send(command);
        const result = await denied; expect(result.event).toBe("denied");
        expect(["EACCES", "EPERM", "EXDEV"]).toContain(result.code); expect(["EACCES", "EPERM", "EXDEV"]).toContain(result.aliasCode);
        await expect(lstat(path.join(canonical, row.main_key))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(path.join(canonical, row.thumb_key))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(path.join(canonical, "forbidden-alias.webp"))).rejects.toMatchObject({ code: "ENOENT" });
        await afterRevocation(a.kill(), () => release.resolve()); // exact child reaped before publication resumes
        await bounded(b, "trusted authority progress");
        const [seal] = await q(sql`SELECT main_dev, main_ino FROM photo_operation_artifacts WHERE operation_id=${row.id} AND generation=2`);
        const published = await lstat(path.join(canonical, row.main_key), { bigint: true });
        expect([String(published.dev), String(published.ino)]).toEqual([seal.main_dev, seal.main_ino]);
        if (kind === "w2") {
          expect((await op(token)).state).toBe("committed");
          expect(Number((await q(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id=${row.target_photo_id}`))[0].n)).toBe(1);
          await upload(kind, token); // lost response / retry: committed identity, no new generation
          expect(Number((await op(token)).generation)).toBe(2);
        } else expect((await op(token)).state).toBe("sealed"); // W4 manifest publication only; existing full-finalization suites verify commit
      } finally {
        try { await afterRevocation(a.kill(), () => release.resolve()); }
        catch (error) {
          // Failed cleanup must abort the waiting owner's hook, never release it to link without revocation.
          void release.promise.catch(() => undefined); release.reject(error); throw error;
        } finally { if (b) await b.catch(() => undefined); }
      }
    });
    it.skipIf(!native || !configured)("PREVENTED offline: reap known capability-owning child before bounded replacement", async () => {
      const token = randomUUID(), a = await child(kind, token, false);
      try {
        expect((await a.message()).event).toBe("sealed");
        const before = await op(token);
        await a.kill(); // not a lease or DB shutdown: actual OS process death precedes transfer
        await expect(lstat(path.join(canonical, before.main_key))).rejects.toMatchObject({ code: "ENOENT" });
        await q(sql`UPDATE photo_operations SET lease_until_ms=0 WHERE id=${before.id} RETURNING id`);
        await bounded(upload(kind, token), "replacement after proven process death");
        expect(Number((await op(token)).generation)).toBe(2);
        expect((await lstat(path.join(canonical, before.main_key))).isFile()).toBe(true);
      } finally { await a.kill(); }
    });
  });
});
