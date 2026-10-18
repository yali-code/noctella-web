/**
 * #472 F2 Step 4 OFFLINE composition proof (single host, unprivileged Linux, SQLite + disposable PostgreSQL).
 * Composes Contract 1 (durable intent, guarded reclaim, T1/T2; since WP1 the runtime photoPublicationIntents module on
 * migration 0043 tables, not wired into any owner), Step 2 (confined executor/worker, supervisor-
 * authenticated completion before authority transfer) and Step 3 (publisher-owned verified copies) around the REAL
 * photo-operation authority and REAL W2/W4 preparation and T2 building blocks. It does NOT prove production
 * integration: the real W2/W4 owners hard-wire publishSealedArtifacts and the lease fence (documented seam).
 * Runtime Photo F2 stays HIGH/FAIL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import sharp from "sharp";
import { AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";
const { root } = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "noctella-f2s4-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DIR: p.join(root, "parent-photos"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" });
  return { root };
});
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { inOwnershipTransaction } from "../src/services/photoOperationAuthority";
import { persistAuthenticatedExecutorExitSteps } from "../src/services/photoPublicationIntents";
import type { F2c1Driver } from "./f2c1/protocol";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const launcher = process.env.F2_CAPABILITY_LAUNCHER;
const native = process.platform === "linux" && !!launcher;
const node = process.execPath;
const executorFixture = path.join(__dirname, "fixtures", "f2s4Executor.ts");
const preparerFixture = path.join(__dirname, "fixtures", "f2s4Preparer.ts");
const apiDir = path.resolve(__dirname, "..");

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required unprivileged Linux composition proof is configured", () => {
  expect(process.platform).toBe("linux"); expect(launcher).toBeTruthy(); expect(process.getuid?.()).not.toBe(0);
});
it.runIf(process.env.F2C1_REQUIRE_POSTGRES === "1")("required PostgreSQL execution for the composition proof is configured", () => {
  expect(postgresTestConfigured).toBe(true);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

async function bounded<T>(p: Promise<T>, label: string, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("BLOCKED: " + label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Event wait; the deadline is only a failure bound, never a passing condition. */
const until = (check: () => boolean, label: string) => bounded(new Promise<void>((resolve) => { const t = () => (check() ? resolve() : setTimeout(t, 20)); t(); }), label);
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stat = (file: string) => { const s = fs.lstatSync(file, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino), nlink: Number(s.nlink) }; };

interface Proc { child: ChildProcess; name: string; actorId: string; out: () => string; reports: Map<number, { lines: string[]; ended: boolean }>; exit: Promise<void>; send: (cmd: string, args?: unknown) => Promise<any>; fire: (cmd: string, args?: unknown) => void }
function lines(target: string[]) { let rest = ""; return (d: Buffer) => { rest += d; const p = rest.split("\n"); rest = p.pop()!; target.push(...p); }; }
async function start(name: string, cmd: string, args: string[], stdio: any[], env: NodeJS.ProcessEnv, reportFds: number[], actorId: string): Promise<Proc> {
  const child = spawn(cmd, args, { cwd: apiDir, stdio, env: { ...process.env, ...env } });
  let log = ""; child.stdout?.on("data", (d) => { log += d; }); child.stderr?.on("data", (d) => { log += d; });
  const reports = new Map<number, { lines: string[]; ended: boolean }>();
  for (const fd of reportFds) { const e = { lines: [] as string[], ended: false }; const s = child.stdio[fd] as NodeJS.ReadableStream; s.on("data", lines(e.lines)); s.on("end", () => { e.ended = true; }); reports.set(fd, e); }
  const exit = new Promise<void>((r) => child.once("exit", () => r()));
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(); let next = 0;
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (m: any) => {
      if (m?.type === "ready") resolve();
      else if (m?.type === "fatal") reject(new Error(name + " fatal: " + m.error + " " + log.slice(-1500)));
      else if (m?.type === "reply") { const p = pending.get(m.id); pending.delete(m.id); if (p) (m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))); }
    });
  });
  const proc: Proc = {
    child, name, actorId, out: () => log, reports, exit,
    send: (c, a) => bounded(new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ type: "cmd", id, cmd: c, args: a }); }), `${name}:${c} ${log.slice(-800)}`),
    fire: (c, a) => { child.send({ type: "cmd", id: ++next, cmd: c, args: a }); },
  };
  await bounded(ready, `${name} ready ${log.slice(-1500)}`);
  return proc;
}

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("F2 Step 4 composition on %s", (driver: F2c1Driver, configured) => {
  let db: any, raw: Database.Database | undefined, close = async () => {}, dbUrl = "", categoryId = "";
  const base = path.join(root, driver), canonical = path.join(base, "photos"), staging = path.join(base, "publisher-staging");
  const privateRoot = path.join(base, ".product-photo-operations"), dbDir = path.join(base, "db");
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const owned: Proc[] = [];
  const q = async (s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;
  const n = async (s: SQL) => Number((await q(s))[0].n);

  beforeAll(async () => {
    if (!native || !configured) return;
    for (const d of [canonical, staging, privateRoot, dbDir]) fs.mkdirSync(d, { recursive: true });
    process.env.DATABASE_DRIVER = driver;
    if (driver === "postgres") {
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const h = await createPostgresTestDb("0043_photo_publication_intents.sql"); db = h.db; close = () => h.close();
      const url = new URL(process.env.POSTGRES_TEST_DATABASE_URL!); url.searchParams.set("options", "-c search_path=" + h.schemaName); dbUrl = url.toString();
    } else {
      dbUrl = path.join(dbDir, "f2s4.sqlite"); process.env.DATABASE_URL = dbUrl;
      raw = new Database(dbUrl); raw.pragma("journal_mode=WAL"); raw.pragma("foreign_keys=ON"); ensureSchema(raw);
      db = drizzle(raw, { schema }); close = async () => { raw!.close(); };
    }
    categoryId = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, 'F2S4', ${"f2s4-" + categoryId}) RETURNING id`);
  });
  afterEach(async () => {
    // Test-owned cleanup: SIGTERM each reaper (pidfd sweep) and kill direct preparers; every exit is observed.
    for (const p of owned.splice(0)) {
      if (p.child.exitCode !== null || p.child.signalCode !== null) continue;
      if (p.reports.has(5)) { p.child.kill("SIGTERM"); await bounded(p.exit, p.name + " reaper"); expect(p.reports.get(5)!.lines).toContain("F2PA1 REAPER_COMPLETE"); }
      else { p.child.kill("SIGKILL"); await bounded(p.exit, p.name + " exit"); }
    }
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  const childEnv = (actorId: string, tmp: string): NodeJS.ProcessEnv => {
    let url = dbUrl;
    if (driver === "postgres") { const u = new URL(dbUrl); u.searchParams.set("application_name", actorId); url = u.toString(); }
    return { DATABASE_DRIVER: driver, DATABASE_URL: url, TMPDIR: tmp, PRODUCT_PHOTO_DIR: canonical, MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      MARKETPLACE_OAUTH_STATE_SECRET: "test-f2s4", ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000" };
  };
  /** reaper -> supervisor -> CONFINED executor (allowlist: canonical, staging, private root, db dir, own tmp). */
  async function executor(name: string) {
    const actorId = `${name}-${randomUUID()}`, tmp = fs.mkdtempSync(path.join(base, "exec-tmp-"));
    const args = ["--reaper", "--report-fd=5", "--", launcher!, "--supervise", "--report-fd=4", canonical, staging, privateRoot, dbDir, tmp, "--", node, "--import", "tsx", executorFixture];
    const p = await start(name, launcher!, args, ["ignore", "pipe", "pipe", "ipc", "pipe", "pipe"], { ...childEnv(actorId, tmp), F2S4_DRIVER: driver, F2S4_CANONICAL: canonical, F2S4_STAGING: staging, F2S4_ACTOR_ID: actorId }, [4, 5], actorId);
    owned.push(p);
    // stderr and IPC are separate channels: wait for the confinement marker as an event, never assume ordering.
    await until(() => p.out().includes("LANDLOCK_ENFORCED"), name + " confinement marker");
    return p;
  }
  /** CONFINED preparation worker (allowlist: the generation directory and its own tmp). */
  async function preparer(genDir: string) {
    const tmp = fs.mkdtempSync(path.join(base, "prep-tmp-"));
    const p = await start("preparer", launcher!, [genDir, tmp, "--", node, "--import", "tsx", preparerFixture], ["ignore", "pipe", "pipe", "ipc"], childEnv("preparer", tmp), [], "preparer");
    owned.push(p);
    return { p, tmp };
  }
  /** Authenticated completion (Step 2): supervisor record bound to the reaper-observed exit of that supervisor. */
  function gate(e: Proc): "COMPLETE" | "BLOCKED" {
    const s = e.reports.get(4)!, r = e.reports.get(5)!;
    const recs = s.lines.filter(Boolean);
    const done = s.ended && recs.length === 1 ? /^F2PA1 COMPLETE supervisor=(\d+) worker_status=(-?\d+)$/.exec(recs[0]) : null;
    const inner = r.lines.map((l) => /^F2PA1 INNER_EXIT pid=(\d+) code=(\d+)$/.exec(l)).find(Boolean);
    return done && inner && inner[1] === done[1] && inner[2] === "0" ? "COMPLETE" : "BLOCKED";
  }
  /** Executor death -> authenticated completion -> (PostgreSQL) backend gone -> Contract 1 exit records. Never a raw PID. */
  async function authenticateExitAndReceipt(e: Proc, operationIds: string[], epoch: number) {
    await until(() => e.reports.get(4)!.ended && e.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), e.name + " completion");
    expect(gate(e)).toBe("COMPLETE");
    if (driver === "postgres") {
      const deadline = Date.now() + 15_000;
      while (Number((await q(sql`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = ${e.actorId}`))[0].n) !== 0) {
        if (Date.now() > deadline) throw new Error("BLOCKED: backend of exited executor still present");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    for (const id of operationIds) await inOwnershipTransaction(db, driver, () => persistAuthenticatedExecutorExitSteps(driver, { operationId: id, epoch, executorIdentity: e.actorId, attestedBy: "trusted-test-parent" }));
  }

  async function product() {
    const id = randomUUID();
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${id}, ${"F2S4-" + id}, 'Synthetic', ${"f2s4-" + id}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
    return id;
  }
  async function input(width: number) {
    const file = path.join(base, "input-" + randomUUID() + ".jpg");
    fs.writeFileSync(file, await sharp({ create: { width, height: 80, channels: 3, background: "#704030" } }).jpeg().toBuffer());
    return { file, size: fs.statSync(file).size, sha256: sha(file) };
  }
  async function w4Intake(count: number) {
    const productId = await product(), intakeId = randomUUID(), staged: { id: string; input: Awaited<ReturnType<typeof input>> }[] = [];
    await q(sql`INSERT INTO ai_product_intakes (id, status, created_by_admin_user_id, result_product_id, applied_at, applied_by_admin_user_id) VALUES (${intakeId}, ${AiProductIntakeStatus.Applied}, 'admin-1', ${productId}, ${new Date().toISOString()}, 'admin-1') RETURNING id`);
    for (let i = 0; i < count; i++) {
      const id = randomUUID(), src = await input(100 + i * 40);
      await q(sql`INSERT INTO ai_intake_photos (id, intake_id, storage_key, original_filename, created_by_admin_user_id, created_at, updated_at) VALUES (${id}, ${intakeId}, ${randomUUID() + ".webp"}, ${"photo-" + i + ".jpg"}, 'admin-1', ${new Date().toISOString()}, ${new Date().toISOString()}) RETURNING id`);
      staged.push({ id, input: src });
    }
    return { productId, intakeId, staged };
  }

  /** Claim + real preparation by a confined worker (which keeps a retained fd and an alias) + real seal. */
  async function prepared(e: Proc, i: number, claimArgs: Record<string, unknown>, src: { file: string }, kind: "w2" | "w4") {
    const claim = await e.send("claim", { ...claimArgs, i, kind });
    expect(claim.kind).toBe("owned");
    const { dir } = await e.send("genDir", { i });
    const w = await preparer(dir);
    // Trusted staging, as the real W2 admission layer does: the staged input is the regular file `<workDir>/input`
    // (stagedProductPhotoStorage validates dirname, basename "input", no symlink, realpath and size).
    const stagedInput = path.join(w.tmp, "input");
    fs.copyFileSync(src.file, stagedInput);
    const files = await w.p.send("prepare", { kind, input: stagedInput, genDir: dir, workDir: w.tmp });
    expect(typeof (await w.p.send("retain", { path: files.main }))).toBe("number");
    expect(await w.p.send("alias", { from: files.main, to: path.join(dir, "alias.webp") })).toBe("OK");
    const sealed = await e.send("seal", { i, files: { main: files.main, thumb: files.thumb } });
    expect(sealed.sealed).toBe(true);
    return { op: claim.op, files, seal: sealed.seal, worker: w.p, dir };
  }
  const expire = (opId: string) => q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE id = ${opId} RETURNING id`);
  // photo_operations.generation is BIGINT on PostgreSQL; node-postgres returns int8 as a string, SQLite as a number.
  const opRow = async (id: string) => { const [row] = await q(sql`SELECT state, generation FROM photo_operations WHERE id = ${id}`); return { state: row.state, generation: Number(row.generation) }; };
  const intentState = async (id: string) => (await q(sql`SELECT state, executor_epoch FROM photo_publication_intents WHERE operation_id = ${id}`))[0];
  const effects = async (photoId: string) => [await n(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id = ${photoId}`), await n(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ${photoId}`)];
  const canonicalOf = (op: any, artifact: "main" | "thumb") => path.join(canonical, artifact === "main" ? op.mainKey : op.thumbKey);
  const absent = (op: any) => { for (const a of ["main", "thumb"] as const) expect(fs.existsSync(canonicalOf(op, a)), a).toBe(false); };
  /** Physical proof: canonical name = publisher-owned recorded inode (not the worker inode), sealed bytes, nlink 1. */
  async function expectPublished(op: any, generation: number) {
    const [seal] = await q(sql`SELECT main_sha256, thumb_sha256, main_dev, main_ino, thumb_dev, thumb_ino FROM photo_operation_artifacts WHERE operation_id = ${op.id} AND generation = ${generation}`);
    for (const a of ["main", "thumb"] as const) {
      const file = canonicalOf(op, a), st = stat(file);
      const manifest = JSON.parse(fs.readFileSync(path.join(staging, `${op.id}-${a}`, String(generation), "manifest.json"), "utf8"));
      expect([st.dev, st.ino, st.nlink], a).toEqual([manifest.dev, manifest.ino, 1]);
      expect([st.dev, st.ino], a).not.toEqual([String(seal[a + "_dev"]), String(seal[a + "_ino"])]);
      expect(sha(file), a).toBe(seal[a + "_sha256"]);
      expect(fs.readdirSync(path.join(staging, `${op.id}-${a}`, String(generation))), a).toEqual(["manifest.json"]);
    }
  }
  const run = (name: string, fn: () => Promise<void>) => it.skipIf(!native || !configured)(name, fn);

  // ------------------------------------------------------------------ W2 ------------------------------------------------------------------
  const w2Claim = (src: { sha256: string }, productId: string, token = randomUUID()) => ({ token, productId, sha256: src.sha256 });
  const w2T2 = (r: { op: any; files: any }, productId: string, src: { size: number }) => ({ i: 0, productId, photoId: r.op.photoId, sizeBytes: src.size, width: r.files.width, height: r.files.height });

  run("W2-1/8: sealed source -> verified publisher-owned inode -> canonical -> T2; retained worker authority cannot alter bytes", async () => {
    const productId = await product(), src = await input(120), e = await executor("E");
    const r = await prepared(e, 0, w2Claim(src, productId), src, "w2");
    expect((await e.send("t1", { i: 0 })).kind).toBe("own");
    absent(r.op); // T1 precedes any canonical name
    const pub = await e.send("publish", { i: 0 });
    expect([pub.status, pub.outcomes.main.kind, pub.outcomes.thumb.kind]).toEqual(["published", "PUBLISHED", "PUBLISHED"]);
    expect(await effects(r.op.photoId)).toEqual([0, 0]); // physically present, not yet DB-visible
    expect(await e.send("t2w2", w2T2(r, productId, src))).toEqual({ committed: true });
    expect([(await opRow(r.op.id)).state, (await intentState(r.op.id)).state]).toEqual(["committed", "committed"]);
    expect(await effects(r.op.photoId)).toEqual([1, 1]);
    await expectPublished(r.op, 1);
    expect(await r.worker.send("writeRetained", { offset: 0, content: "RETAINED" })).toBe("OK");
    expect(await r.worker.send("writeAt", { path: path.join(r.dir, "alias.webp"), offset: 8, content: "ALIAS" })).toBe("OK");
    expect(["EACCES", "EPERM"]).toContain(await r.worker.send("openWrite", { path: canonicalOf(r.op, "main") }));
    await expectPublished(r.op, 1); // source mutation and aliases never reach published bytes
  });

  run("W2-2: reclaim before intent -> the stale owner can neither create a canonical name nor commit", async () => {
    const productId = await product(), src = await input(121), a = await executor("A"), b = await executor("B");
    const token = randomUUID(), ra = await prepared(a, 0, w2Claim(src, productId, token), src, "w2");
    await expire(ra.op.id);
    const rb = await prepared(b, 0, w2Claim(src, productId, token), src, "w2");
    expect((await opRow(ra.op.id)).generation).toBe(2);
    expect((await a.send("t1", { i: 0 })).kind).toBe("rejected");
    expect(await a.send("publish", { i: 0 })).toEqual({ refused: "no-authority" });
    expect(await a.send("t2w2", w2T2(ra, productId, src))).toEqual({ refused: "no-authority" });
    absent(ra.op);
    expect((await b.send("t1", { i: 0 })).kind).toBe("own");
    expect((await b.send("publish", { i: 0 })).status).toBe("published");
    expect(await b.send("t2w2", w2T2(rb, productId, src))).toEqual({ committed: true });
    await expectPublished(rb.op, 2);
    expect(await effects(rb.op.photoId)).toEqual([1, 1]);
  });

  run("W2-3/10: intent active -> reclaim blocked; transfer without authenticated completion -> BLOCKED", async () => {
    const productId = await product(), src = await input(122), a = await executor("A"), b = await executor("B");
    const token = randomUUID(), ra = await prepared(a, 0, w2Claim(src, productId, token), src, "w2");
    expect((await a.send("t1", { i: 0 })).kind).toBe("own");
    await expire(ra.op.id);
    expect((await b.send("claim", { kind: "w2", i: 0, ...w2Claim(src, productId, token) })).kind).toBe("in-progress");
    expect((await b.send("transfer", { i: 0, operationId: ra.op.id, expectedEpoch: 1 })).kind).toBe("no-exit-record");
    absent(ra.op);
    expect((await a.send("publish", { i: 0 })).status).toBe("published");
    expect(await a.send("t2w2", w2T2(ra, productId, src))).toEqual({ committed: true });
    await expectPublished(ra.op, 1);
  });

  run("W2-5: lost acknowledgement after T2 -> retry reads the committed result; no duplicate rows or files", async () => {
    const productId = await product(), src = await input(123), e = await executor("E");
    const r = await prepared(e, 0, w2Claim(src, productId), src, "w2");
    await e.send("t1", { i: 0 }); await e.send("publish", { i: 0 });
    const before = stat(canonicalOf(r.op, "main"));
    expect(await e.send("t2w2", { ...w2T2(r, productId, src), lostAck: true })).toEqual({ lostAck: true });
    expect(await e.send("t2w2", w2T2(r, productId, src))).toEqual({ committed: true, already: true });
    expect(await effects(r.op.photoId)).toEqual([1, 1]);
    expect(stat(canonicalOf(r.op, "main")).ino).toBe(before.ino);
    await expectPublished(r.op, 1);
  });

  for (const boundary of ["before-intent", "after-intent", "main:verified", "main:linked", "after-commit"] as const) {
    run(`W2-4/6/9: SIGKILL ${boundary} -> authenticated completion -> recovery adopts only authorized artifacts`, async () => {
      const productId = await product(), src = await input(124), e1 = await executor("E1");
      const token = randomUUID(), r = await prepared(e1, 0, w2Claim(src, productId, token), src, "w2");
      if (boundary !== "before-intent") expect((await e1.send("t1", { i: 0 })).kind).toBe("own");
      if (boundary === "after-commit") { await e1.send("publish", { i: 0 }); e1.fire("t2w2", { ...w2T2(r, productId, src), crashAfter: true }); }
      else if (boundary.includes(":")) e1.fire("publish", { i: 0, crashAt: boundary });
      else e1.fire("crash");
      await authenticateExitAndReceipt(e1, boundary === "before-intent" ? [] : [r.op.id], 1);
      // Physical state at the kill boundary.
      const mainPresent = boundary === "main:linked" || boundary === "after-commit";
      expect(fs.existsSync(canonicalOf(r.op, "main"))).toBe(mainPresent);
      expect(fs.existsSync(canonicalOf(r.op, "thumb"))).toBe(boundary === "after-commit");
      expect(await effects(r.op.photoId)).toEqual(boundary === "after-commit" ? [1, 1] : [0, 0]);
      const linkedInode = mainPresent ? stat(canonicalOf(r.op, "main")).ino : null;
      const e2 = await executor("E2");
      if (boundary === "after-commit") {
        expect((await e2.send("claim", { kind: "w2", i: 0, ...w2Claim(src, productId, token) })).kind).toBe("committed");
        expect(await effects(r.op.photoId)).toEqual([1, 1]);
        expect(stat(canonicalOf(r.op, "main")).ino).toBe(linkedInode);
        return;
      }
      if (boundary === "before-intent") {
        await expire(r.op.id);
        const r2 = await prepared(e2, 0, w2Claim(src, productId, token), src, "w2");
        expect((await e2.send("t1", { i: 0 })).kind).toBe("own");
        expect((await e2.send("publish", { i: 0 })).outcomes.main.kind).toBe("PUBLISHED");
        expect(await e2.send("t2w2", w2T2(r2, productId, src))).toEqual({ committed: true });
        await expectPublished(r2.op, 2);
        expect(fs.existsSync(path.join(privateRoot, r.op.id, "1", "main.webp"))).toBe(true); // worker-owned names never cleaned
        return;
      }
      await e2.send("adopt", { i: 0, op: r.op });
      expect((await e2.send("transfer", { i: 0, operationId: r.op.id, expectedEpoch: 1 })).kind).toBe("own");
      const pub = await e2.send("publish", { i: 0 });
      expect(pub.outcomes.main.kind).toBe(boundary === "main:linked" ? "ADOPTED" : "PUBLISHED");
      expect(pub.outcomes.thumb.kind).toBe("PUBLISHED");
      if (linkedInode) expect(stat(canonicalOf(r.op, "main")).ino).toBe(linkedInode);
      expect(await e2.send("t2w2", w2T2(r, productId, src))).toEqual({ committed: true });
      await expectPublished(r.op, 1);
      expect([(await intentState(r.op.id)).state, Number((await intentState(r.op.id)).executor_epoch)]).toEqual(["committed", 2]);
      expect(await effects(r.op.photoId)).toEqual([1, 1]);
    });
  }

  run("W2-7: a foreign canonical file is a collision -> review; never adopted, overwritten or committed", async () => {
    const productId = await product(), src = await input(125), e = await executor("E");
    const r = await prepared(e, 0, w2Claim(src, productId), src, "w2");
    expect((await e.send("t1", { i: 0 })).kind).toBe("own");
    fs.writeFileSync(canonicalOf(r.op, "main"), "FOREIGN"); const foreign = stat(canonicalOf(r.op, "main"));
    const pub = await e.send("publish", { i: 0 });
    expect([pub.status, pub.outcomes.main.kind]).toEqual(["review", "COLLISION"]);
    expect([stat(canonicalOf(r.op, "main")).ino, fs.readFileSync(canonicalOf(r.op, "main"), "utf8")]).toEqual([foreign.ino, "FOREIGN"]);
    await expect(e.send("t2w2", w2T2(r, productId, src))).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST");
    expect([(await opRow(r.op.id)).state, (await intentState(r.op.id)).state]).toEqual(["review", "review"]);
    expect(await effects(r.op.photoId)).toEqual([0, 0]);
  });

  run("W2-8: source mutation through a retained descriptor after the seal is rejected before any canonical name", async () => {
    const productId = await product(), src = await input(126), e = await executor("E");
    const r = await prepared(e, 0, w2Claim(src, productId), src, "w2");
    expect((await e.send("t1", { i: 0 })).kind).toBe("own");
    expect(await r.worker.send("writeRetained", { offset: 0, content: "MUTATED" })).toBe("OK");
    const pub = await e.send("publish", { i: 0 });
    expect([pub.status, pub.outcomes.main.kind]).toEqual(["review", "SNAPSHOT_MISMATCH"]);
    absent(r.op);
    expect(await effects(r.op.photoId)).toEqual([0, 0]);
  });

  run("W2-10: supervisor loss -> no authenticated completion -> no exit record, no transfer, no reclaim (BLOCKED)", async () => {
    const productId = await product(), src = await input(127), a = await executor("A"), b = await executor("B");
    const token = randomUUID(), r = await prepared(a, 0, w2Claim(src, productId, token), src, "w2");
    expect((await a.send("t1", { i: 0 })).kind).toBe("own");
    a.fire("killSupervisor");
    await until(() => a.reports.get(4)!.ended && a.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "supervisor death");
    expect(a.reports.get(5)!.lines).toContainEqual(expect.stringMatching(/^F2PA1 INNER_EXIT pid=\d+ signal=9$/));
    expect(gate(a)).toBe("BLOCKED");
    expect((await b.send("transfer", { i: 0, operationId: r.op.id, expectedEpoch: 1 })).kind).toBe("no-exit-record");
    await expire(r.op.id);
    expect((await b.send("claim", { kind: "w2", i: 0, ...w2Claim(src, productId, token) })).kind).toBe("in-progress");
    absent(r.op);
    expect([(await opRow(r.op.id)).state, (await intentState(r.op.id)).state]).toEqual(["sealed", "authorized"]);
  });

  // ------------------------------------------------------------------ W4 ------------------------------------------------------------------
  const w4Claim = (s: { id: string; input: { sha256: string } }, productId: string) => ({ productId, stagedPhotoId: s.id, sha256: s.input.sha256 });
  const w4Entries = (rs: Array<{ files: any }>, staged: Array<{ id: string; input: { size: number } }>) =>
    staged.map((s, i) => ({ i, stagedPhotoId: s.id, sortOrder: i, isPrimary: i === 0, sizeBytes: s.input.size, width: rs[i].files.width, height: rs[i].files.height }));
  const intakeStatus = async (id: string) => (await q(sql`SELECT status FROM ai_product_intakes WHERE id = ${id}`))[0].status;
  const productPhotos = (productId: string) => n(sql`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ${productId}`);

  run("W4-1/8/9: two staged photos -> verified copies -> ONE finalization transaction; physical names precede DB visibility", async () => {
    const { productId, intakeId, staged } = await w4Intake(2), e = await executor("E");
    const rs = [];
    for (const [i, s] of staged.entries()) rs.push(await prepared(e, i, w4Claim(s, productId), s.input, "w4"));
    for (let i = 0; i < 2; i++) expect((await e.send("t1", { i })).kind).toBe("own");
    for (let i = 0; i < 2; i++) expect((await e.send("publish", { i })).status).toBe("published");
    expect([await productPhotos(productId), await intakeStatus(intakeId)]).toEqual([0, "applied"]); // all-or-nothing DB visibility
    expect(await e.send("t2w4", { intakeId, productId, entries: w4Entries(rs, staged) })).toEqual({ committed: true });
    expect([await productPhotos(productId), await intakeStatus(intakeId)]).toEqual([2, "finalized"]);
    for (const r of rs) { await expectPublished(r.op, 1); expect([(await opRow(r.op.id)).state, (await intentState(r.op.id)).state]).toEqual(["committed", "committed"]); }
    expect(await rs[0].worker.send("writeRetained", { offset: 0, content: "RETAINED" })).toBe("OK");
    await expectPublished(rs[0].op, 1);
  });

  run("W4-2/3: reclaim before intent rejects the stale owner; an active intent blocks reclaim", async () => {
    const { productId, staged } = await w4Intake(2), a = await executor("A"), b = await executor("B");
    const r0 = await prepared(a, 0, w4Claim(staged[0], productId), staged[0].input, "w4");
    const r1 = await prepared(a, 1, w4Claim(staged[1], productId), staged[1].input, "w4");
    expect((await a.send("t1", { i: 1 })).kind).toBe("own"); // photo 1: intent active
    await expire(r0.op.id); await expire(r1.op.id);
    expect((await b.send("claim", { kind: "w4", i: 1, ...w4Claim(staged[1], productId) })).kind).toBe("in-progress");
    const rb = await prepared(b, 0, w4Claim(staged[0], productId), staged[0].input, "w4"); // photo 0: reclaimed (generation 2)
    expect((await opRow(r0.op.id)).generation).toBe(2);
    expect((await a.send("t1", { i: 0 })).kind).toBe("rejected");
    expect(await a.send("publish", { i: 0 })).toEqual({ refused: "no-authority" });
    absent(r0.op); absent(r1.op);
    expect((await b.send("t1", { i: 0 })).kind).toBe("own");
    expect((await b.send("publish", { i: 0 })).status).toBe("published");
    await expectPublished(rb.op, 2);
  });

  run("W4-5: lost acknowledgement after the finalization transaction -> durable result, no duplicates", async () => {
    const { productId, intakeId, staged } = await w4Intake(2), e = await executor("E");
    const rs = [];
    for (const [i, s] of staged.entries()) rs.push(await prepared(e, i, w4Claim(s, productId), s.input, "w4"));
    for (let i = 0; i < 2; i++) { await e.send("t1", { i }); await e.send("publish", { i }); }
    expect(await e.send("t2w4", { intakeId, productId, entries: w4Entries(rs, staged), lostAck: true })).toEqual({ lostAck: true });
    expect(await e.send("t2w4", { intakeId, productId, entries: w4Entries(rs, staged) })).toEqual({ committed: true, already: true });
    expect([await productPhotos(productId), await intakeStatus(intakeId)]).toEqual([2, "finalized"]);
    for (const r of rs) await expectPublished(r.op, 1);
  });

  run("W4-4/6/9: SIGKILL during photo 2 after its main link -> authenticated transfer -> idempotent multi-artifact recovery", async () => {
    const { productId, intakeId, staged } = await w4Intake(2), e1 = await executor("E1");
    const rs = [];
    for (const [i, s] of staged.entries()) rs.push(await prepared(e1, i, w4Claim(s, productId), s.input, "w4"));
    for (let i = 0; i < 2; i++) expect((await e1.send("t1", { i })).kind).toBe("own");
    expect((await e1.send("publish", { i: 0 })).status).toBe("published");
    const unrelated = path.join(canonical, "unrelated-" + randomUUID() + ".webp"); fs.writeFileSync(unrelated, "UNRELATED");
    e1.fire("publish", { i: 1, crashAt: "main:linked" });
    await authenticateExitAndReceipt(e1, rs.map((r) => r.op.id), 1);
    expect([fs.existsSync(canonicalOf(rs[1].op, "main")), fs.existsSync(canonicalOf(rs[1].op, "thumb"))]).toEqual([true, false]);
    expect([await productPhotos(productId), await intakeStatus(intakeId)]).toEqual([0, "applied"]);
    const inodes = [stat(canonicalOf(rs[0].op, "main")).ino, stat(canonicalOf(rs[0].op, "thumb")).ino, stat(canonicalOf(rs[1].op, "main")).ino];
    const e2 = await executor("E2");
    for (const [i, r] of rs.entries()) { await e2.send("adopt", { i, op: r.op }); expect((await e2.send("transfer", { i, operationId: r.op.id, expectedEpoch: 1 })).kind).toBe("own"); }
    const p0 = await e2.send("publish", { i: 0 }), p1 = await e2.send("publish", { i: 1 });
    expect([p0.outcomes.main.kind, p0.outcomes.thumb.kind, p1.outcomes.main.kind, p1.outcomes.thumb.kind]).toEqual(["ADOPTED", "ADOPTED", "ADOPTED", "PUBLISHED"]);
    expect([stat(canonicalOf(rs[0].op, "main")).ino, stat(canonicalOf(rs[0].op, "thumb")).ino, stat(canonicalOf(rs[1].op, "main")).ino]).toEqual(inodes);
    expect(await e2.send("t2w4", { intakeId, productId, entries: w4Entries(rs, staged) })).toEqual({ committed: true });
    expect([await productPhotos(productId), await intakeStatus(intakeId)]).toEqual([2, "finalized"]);
    for (const r of rs) await expectPublished(r.op, 1);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("UNRELATED"); // cleanup never touches foreign or committed artifacts
  });

  run("W4-7: a foreign collision on photo 2 -> review -> the single finalization transaction commits nothing", async () => {
    const { productId, intakeId, staged } = await w4Intake(2), e = await executor("E");
    const rs = [];
    for (const [i, s] of staged.entries()) rs.push(await prepared(e, i, w4Claim(s, productId), s.input, "w4"));
    for (let i = 0; i < 2; i++) expect((await e.send("t1", { i })).kind).toBe("own");
    expect((await e.send("publish", { i: 0 })).status).toBe("published");
    fs.writeFileSync(canonicalOf(rs[1].op, "main"), "FOREIGN"); const foreign = stat(canonicalOf(rs[1].op, "main"));
    expect((await e.send("publish", { i: 1 })).outcomes.main.kind).toBe("COLLISION");
    await expect(e.send("t2w4", { intakeId, productId, entries: w4Entries(rs, staged) })).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST");
    expect([await productPhotos(productId), await intakeStatus(intakeId)]).toEqual([0, "applied"]);
    expect([(await opRow(rs[0].op.id)).state, (await opRow(rs[1].op.id)).state]).toEqual(["sealed", "review"]);
    expect([stat(canonicalOf(rs[1].op, "main")).ino, fs.readFileSync(canonicalOf(rs[1].op, "main"), "utf8")]).toEqual([foreign.ino, "FOREIGN"]);
    await expectPublished(rs[0].op, 1); // photo 1 is physically published per the W4 contract, but not DB-visible
  });

  run("W4-10: supervisor loss -> BLOCKED; no exit record, no transfer, no reclaim", async () => {
    const { productId, staged } = await w4Intake(1), a = await executor("A"), b = await executor("B");
    const r = await prepared(a, 0, w4Claim(staged[0], productId), staged[0].input, "w4");
    expect((await a.send("t1", { i: 0 })).kind).toBe("own");
    a.fire("killSupervisor");
    await until(() => a.reports.get(4)!.ended && a.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "supervisor death");
    expect(gate(a)).toBe("BLOCKED");
    expect((await b.send("transfer", { i: 0, operationId: r.op.id, expectedEpoch: 1 })).kind).toBe("no-exit-record");
    await expire(r.op.id);
    expect((await b.send("claim", { kind: "w4", i: 0, ...w4Claim(staged[0], productId) })).kind).toBe("in-progress");
    absent(r.op);
  });
});
