/**
 * #472 F2 Contract 1 OFFLINE PROOF (W2 only). Cooperative-worker ordering between reclaim and canonical-name
 * creation, exactly-once commit and crash recovery, using real child processes, the real photo authority and
 * a TEST-ONLY intent-authorized fence. Proves nothing about capability enforcement or byte immutability, does
 * not accept production availability, and does not change runtime Photo F2 (HIGH/FAIL).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import sharp from "sharp";
import { ProductStatus, ProductType } from "@noctella/shared";
const { root } = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "noctella-f2c1-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DIR: p.join(root, "parent-photos"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" });
  return { root };
});
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { claimExistingOperation, inOwnershipTransaction, PHOTO_OPERATION_LEASE_MS } from "../src/services/photoOperationAuthority";
import { persistFencedUploadedProductPhoto } from "../src/services/products";
import { commitDrizzlePhotoOperationFenced } from "../src/services/photoOperationCommitFence";
import { productPhotoStaticPath } from "../src/services/photoStorage";
import { f2c1IntentDdl, type F2c1Driver } from "./f2c1/intentSchema";
import { harnessT2, inF2c1Transaction, recordExitReceiptSteps } from "./f2c1/protocol";
import { linkAttempts, validateLinkAuthorization, type TraceEvent } from "./f2c1/trace";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const actorScript = path.join(__dirname, "fixtures", "f2c1Actor.ts");
const observer = path.join(__dirname, "fixtures", "f2c1LinkObserver.cjs");

// Runs after both driver blocks' own hooks have closed their databases and killed their actors.
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

it.runIf(process.env.F2C1_REQUIRE_POSTGRES === "1")("required PostgreSQL execution for the Contract 1 proof is configured", () => {
  expect(postgresTestConfigured).toBe(true);
});

async function bounded<T>(promise: Promise<T>, label: string, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("TIMEOUT: " + label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

interface Actor { name: string; id: string; proc: ChildProcess; exited: Promise<void>; send: (cmd: string, args?: unknown) => Promise<any>; kill: () => Promise<void> }

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("F2 Contract 1 offline proof on %s", (driver: F2c1Driver, configured) => {
  let db: any, raw: Database.Database | undefined, close = async () => {}, childUrl = "", input: Buffer, digest = "";
  const canonical = path.join(root, driver, "photos");
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const trace: TraceEvent[] = [];
  const actors: Actor[] = [];
  const q = async (s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;

  beforeAll(async () => {
    if (!configured) return;
    await mkdir(canonical, { recursive: true });
    process.env.DATABASE_DRIVER = driver;
    if (driver === "postgres") {
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const h = await createPostgresTestDb("0041_photo_w2_upload_intents.sql"); db = h.db; close = () => h.close();
      for (const ddl of f2c1IntentDdl("postgres")) await db.execute(sql.raw(ddl));
      const url = new URL(process.env.POSTGRES_TEST_DATABASE_URL!); url.searchParams.set("options", "-c search_path=" + h.schemaName); childUrl = url.toString();
    } else {
      childUrl = path.join(root, "f2c1.sqlite"); process.env.DATABASE_URL = childUrl;
      raw = new Database(childUrl); raw.pragma("journal_mode=WAL"); raw.pragma("foreign_keys=ON"); ensureSchema(raw);
      for (const ddl of f2c1IntentDdl("sqlite")) raw.exec(ddl);
      db = drizzle(raw, { schema }); close = async () => { raw!.close(); };
    }
    input = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#704030" } }).jpeg().toBuffer();
    digest = createHash("sha256").update(input).digest("hex");
  });
  afterEach(async () => {
    // Owned children only; every kill is observed to exit (bounded).
    for (const actor of actors.splice(0)) await actor.kill();
    trace.length = 0;
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  async function product() {
    const category = randomUUID(), id = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${category}, 'F2C1', ${"f2c1-" + category}) RETURNING id`);
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${id}, ${"F2C1-" + id}, 'Synthetic', ${"f2c1-" + id}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${category}) RETURNING id`);
    return id;
  }

  async function spawnActor(name: string, env: Record<string, string> = {}): Promise<Actor> {
    const id = `${name}-${randomUUID()}`; // trusted parent-held identity; mapped to this exact ChildProcess
    let url = childUrl;
    if (driver === "postgres") { const u = new URL(childUrl); u.searchParams.set("application_name", id); url = u.toString(); }
    const proc = fork(actorScript, [], {
      execArgv: ["--require", observer, "--import", "tsx"], cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, ...env, DATABASE_DRIVER: driver, DATABASE_URL: url, PRODUCT_PHOTO_DIR: canonical, F2C1_DRIVER: driver, F2C1_CANONICAL: canonical, F2C1_ACTOR_ID: id,
        MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "test-f2c1", ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000" },
    });
    let log = ""; proc.stdout?.on("data", (d) => { log += d; }); proc.stderr?.on("data", (d) => { log += d; });
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let next = 0;
    const ready = new Promise<void>((resolve, reject) => {
      proc.on("message", (m: any) => {
        if (m?.type === "ready") resolve();
        else if (m?.type === "event") trace.push({ actor: name, seq: m.seq, kind: m.kind, data: m.data });
        else if (m?.type === "reply") { const p = pending.get(m.id); pending.delete(m.id); if (!p) return; if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error(m.error), { code: m.code })); }
        else if (m?.type === "fatal") reject(new Error("actor fatal: " + m.error + " " + log.slice(-1500)));
      });
      proc.once("exit", () => { reject(new Error("actor exited: " + log.slice(-1500))); for (const p of pending.values()) p.reject(new Error("actor exited")); });
    });
    await bounded(ready, `${name} ready ${log.slice(-500)}`);
    const actor: Actor = {
      name, id, proc, exited,
      send: (cmd, args) => bounded(new Promise((resolve, reject) => { const mid = ++next; pending.set(mid, { resolve, reject }); proc.send({ type: "cmd", id: mid, cmd, args }); }), `${name}:${cmd}`),
      kill: async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); await bounded(exited, `${name} exit`, 10_000); },
    };
    actors.push(actor);
    return actor;
  }

  /** Trusted parent: observed exit of the exact handle, then (PostgreSQL) no live backend for it, then receipt. */
  async function observeExitAndReceipt(actor: Actor, operationId: string, epoch: number) {
    await actor.kill();
    if (driver === "postgres") {
      const deadline = Date.now() + 10_000;
      while (Number((await q(sql`SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = ${actor.id}`))[0].n) !== 0) {
        if (Date.now() > deadline) throw new Error("BLOCKED: backend of exited executor still present");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await inF2c1Transaction(db, driver, () => recordExitReceiptSteps(driver, operationId, epoch, "trusted-test-parent", actor.id));
  }

  async function sealed(actor: Actor, productId: string, token = randomUUID()) {
    const claim = await actor.send("claim", { token, productId, sha256: digest, altText: "" });
    expect(claim.kind).toBe("owned");
    const workDir = await mkdtemp(path.join(root, "work-"));
    const seal = await actor.send("prepareSeal", { workDir, inputBase64: input.toString("base64") });
    return { token, op: claim.op, seal, productId };
  }
  const expire = (operationId: string) => q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE id = ${operationId} RETURNING id`);
  const opRow = async (id: string) => (await q(sql`SELECT generation, state, lease_until_ms, committed_photo_id FROM photo_operations WHERE id = ${id}`))[0];
  const intentRows = (id: string) => q(sql`SELECT * FROM f2c1_publication_intents WHERE operation_id = ${id}`);
  const effects = async (photoId: string) => [
    Number((await q(sql`SELECT COUNT(*) AS n FROM product_photos WHERE id = ${photoId}`))[0].n),
    Number((await q(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id = ${photoId}`))[0].n),
  ];
  const t2Args = (s: { op: any; seal: any; productId: string }) => ({ productId: s.productId, photoId: s.op.photoId, sizeBytes: s.seal.sizeBytes, width: s.seal.width, height: s.seal.height });
  async function expectCanonicalMatchesIntent(operationId: string) {
    const [intent] = await intentRows(operationId);
    for (const artifact of ["main", "thumb"] as const) {
      const stat = await lstat(path.join(canonical, intent[artifact + "_key"]), { bigint: true });
      expect([String(stat.dev), String(stat.ino)]).toEqual([String(intent[artifact + "_dev"]), String(intent[artifact + "_ino"])]);
    }
  }
  const noViolations = () => expect(validateLinkAuthorization(trace)).toEqual([]);
  const run = (name: string, fn: () => Promise<void>) => it.skipIf(!configured)(name, fn);

  run("C0: the observer detects today's unprotected stale link (sensitivity control)", async () => {
    const productId = await product(), a = await spawnActor("A"), b = await spawnActor("B");
    const s = await sealed(a, productId);
    await expire(s.op.id);
    expect((await b.send("claim", { token: s.token, productId, sha256: digest, altText: "" })).kind).toBe("owned");
    await b.send("prepareSeal", { workDir: await mkdtemp(path.join(root, "work-")), inputBase64: input.toString("base64") });
    await a.send("unprotectedPublish");
    const violations = validateLinkAuthorization(trace);
    expect(violations.filter((v) => v.actor === "A").length).toBeGreaterThan(0);
  });

  run("C1: the unwrapped real claimExistingOperation still reclaims an intent-bearing operation (runtime gap)", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    await expire(s.op.id);
    const claim: any = await inOwnershipTransaction(db, driver, () => claimExistingOperation(driver, s.op.id, PHOTO_OPERATION_LEASE_MS));
    expect(claim.kind).toBe("owned");
    expect(Number((await opRow(s.op.id)).generation)).toBe(2);
  });

  run("C2/P2: the real production fence still rejects after lease expiry", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    await expire(s.op.id);
    await expect(persistFencedUploadedProductPhoto(db, productId, {
      filename: s.op.mainKey, url: `${productPhotoStaticPath}/${s.op.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${s.op.thumbKey}`,
      mimeType: "image/webp", sizeBytes: s.seal.sizeBytes, width: s.seal.width, height: s.seal.height,
    } as any, undefined, { operationId: s.op.id, generation: s.op.generation, owner: s.op.owner, nonce: s.op.nonce, sealId: s.seal.sealId, photoId: s.op.photoId, eventId: randomUUID() })).rejects.toBeTruthy();
    expect((await opRow(s.op.id)).state).toBe("sealed");
    expect(await effects(s.op.photoId)).toEqual([0, 0]);
  });

  run("P1: harness T2 with the REAL fence writes the same rows as the real persist path", async () => {
    const a = await spawnActor("A");
    const x = await sealed(a, await product()), y = await sealed(a, await product());
    const proof = (s: typeof x) => ({ operationId: s.op.id, generation: s.op.generation, owner: s.op.owner, nonce: s.op.nonce, sealId: s.seal.sealId, photoId: s.op.photoId, eventId: randomUUID() });
    await persistFencedUploadedProductPhoto(db, x.productId, { filename: x.op.mainKey, url: `${productPhotoStaticPath}/${x.op.mainKey}`, thumbnailUrl: `${productPhotoStaticPath}/${x.op.thumbKey}`,
      mimeType: "image/webp", sizeBytes: x.seal.sizeBytes, width: x.seal.width, height: x.seal.height } as any, undefined, proof(x));
    const py = proof(y);
    await harnessT2(db, driver, { productId: y.productId, photoId: y.op.photoId, eventId: py.eventId, sizeBytes: y.seal.sizeBytes, width: y.seal.width, height: y.seal.height, mainKey: y.op.mainKey, thumbKey: y.op.thumbKey },
      (tx, execution) => commitDrizzlePhotoOperationFenced(tx, execution, py));
    const photo = async (s: typeof x) => {
      const [r] = await q(sql`SELECT * FROM product_photos WHERE id = ${s.op.photoId}`);
      const pick = (k: string) => r[k] ?? r[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())];
      return { sortOrder: Number(pick("sortOrder")), isPrimary: Boolean(pick("isPrimary")), mimeType: pick("mimeType"), sizeBytes: Number(pick("sizeBytes")), width: Number(pick("width")), height: Number(pick("height")),
        processingStatus: pick("processingStatus"), altText: pick("altText") ?? null, storageKeyMatches: pick("storageKey") === s.op.mainKey, thumbKeyMatches: pick("thumbnailStorageKey") === s.op.thumbKey };
    };
    const event = async (s: typeof x) => {
      const [r] = await q(sql`SELECT * FROM outbox_events WHERE aggregate_id = ${s.op.photoId}`);
      const pick = (k: string) => r[k] ?? r[k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())];
      return { eventType: pick("eventType"), aggregateType: pick("aggregateType"), status: pick("status"), attemptCount: Number(pick("attemptCount")), maxAttempts: Number(pick("maxAttempts")),
        idempotencyKey: String(pick("idempotencyKey")).replace(s.op.photoId, "<id>"),
        // SQLite stores TEXT; PostgreSQL returns JSONB values. Both rows come from the same writer, so compare serialized forms.
        payload: (typeof pick("payload") === "string" ? pick("payload") : JSON.stringify(pick("payload"))).replace(s.op.photoId, "<id>").replace(s.productId, "<product>") };
    };
    expect(await photo(y)).toEqual(await photo(x));
    expect(await event(y)).toEqual(await event(x));
    expect([(await opRow(x.op.id)).state, (await opRow(y.op.id)).state]).toEqual(["committed", "committed"]);
  });

  run("S1: T1 is rejected after reclaim; the rejected actor never reaches link code", async () => {
    const productId = await product(), a = await spawnActor("A"), b = await spawnActor("B");
    const s = await sealed(a, productId);
    await expire(s.op.id);
    expect((await b.send("claim", { token: s.token, productId, sha256: digest, altText: "" })).kind).toBe("owned"); // B commit -> reply -> A next
    const sb = await b.send("prepareSeal", { workDir: await mkdtemp(path.join(root, "work-")), inputBase64: input.toString("base64") });
    expect((await a.send("t1")).kind).toBe("rejected");
    expect(await a.send("link")).toEqual({ refused: "no-authority" });
    expect((await b.send("t1")).kind).toBe("own");
    await b.send("link", { mode: "real" });
    expect(await b.send("t2", { ...t2Args(s), sizeBytes: sb.sizeBytes, width: sb.width, height: sb.height })).toEqual({ committed: true });
    expect(linkAttempts(trace, "A")).toEqual([]); noViolations();
    expect([Number((await opRow(s.op.id)).generation), (await opRow(s.op.id)).state]).toEqual([2, "committed"]);
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
    await expectCanonicalMatchesIntent(s.op.id);
  });

  run("S2: after T1 reclaim is refused; T2 commits with an expired, unrenewed lease", async () => {
    const productId = await product(), a = await spawnActor("A"), b = await spawnActor("B");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    await expire(s.op.id);
    expect((await b.send("claim", { token: s.token, productId, sha256: digest, altText: "" })).kind).toBe("in-progress");
    await a.send("link", { mode: "real" });
    expect(await a.send("t2", t2Args(s))).toEqual({ committed: true });
    const row = await opRow(s.op.id);
    expect([Number(row.generation), row.state, Number(row.lease_until_ms)]).toEqual([1, "committed", 0]); // never renewed
    expect(linkAttempts(trace, "B")).toEqual([]); noViolations();
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
    await expectCanonicalMatchesIntent(s.op.id);
  });

  run("S2b: a live executor that never resumes yields BLOCKED, never a takeover", async () => {
    const productId = await product(), a = await spawnActor("A"), b = await spawnActor("B"), r = await spawnActor("R");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    await expire(s.op.id);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) outcomes.push((await b.send("claim", { token: s.token, productId, sha256: digest, altText: "" })).kind);
    outcomes.push((await r.send("transfer", { operationId: s.op.id, expectedEpoch: 1 })).kind);
    expect(outcomes).toEqual(["in-progress", "in-progress", "in-progress", "no-receipt"]); // asserted outcome: BLOCKED
    const [intent] = await intentRows(s.op.id);
    expect([intent.state, Number(intent.executor_epoch)]).toEqual(["authorized", 1]);
    expect([...linkAttempts(trace, "B"), ...linkAttempts(trace, "R")]).toEqual([]);
    await expect(lstat(path.join(canonical, s.op.mainKey))).rejects.toMatchObject({ code: "ENOENT" });
  });

  run("S3: observed exit + receipt -> transfer to epoch 2; links and T2 only from epoch 2", async () => {
    const productId = await product(), a = await spawnActor("A"), r = await spawnActor("R");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    await observeExitAndReceipt(a, s.op.id, 1);
    expect((await r.send("transfer", { operationId: s.op.id, expectedEpoch: 1 })).kind).toBe("own");
    expect(await r.send("link")).toEqual({ linked: "linked" });
    expect(await r.send("t2", t2Args(s))).toEqual({ committed: true });
    const [intent] = await intentRows(s.op.id);
    expect([intent.state, Number(intent.executor_epoch)]).toEqual(["committed", 2]);
    expect(linkAttempts(trace, "A")).toEqual([]); noViolations();
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
    await expectCanonicalMatchesIntent(s.op.id);
  });

  run("S3b: transfer without a receipt is rejected while the executor may be alive (BLOCKED)", async () => {
    const productId = await product(), a = await spawnActor("A"), r = await spawnActor("R");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    expect((await r.send("transfer", { operationId: s.op.id, expectedEpoch: 1 })).kind).toBe("no-receipt");
    expect(await r.send("link")).toEqual({ refused: "no-authority" });
    expect(linkAttempts(trace, "R")).toEqual([]);
    expect(Number((await intentRows(s.op.id))[0].executor_epoch)).toBe(1);
  });

  run("S3c: concurrent transfers after a valid receipt grant exactly one executor", async () => {
    const productId = await product(), a = await spawnActor("A"), r1 = await spawnActor("R1"), r2 = await spawnActor("R2");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    await observeExitAndReceipt(a, s.op.id, 1);
    const results = await Promise.all([r1.send("transfer", { operationId: s.op.id, expectedEpoch: 1 }), r2.send("transfer", { operationId: s.op.id, expectedEpoch: 1 })]);
    expect(results.map((x) => x.kind).sort()).toEqual(["lost", "own"]);
    const [winner, loser] = results[0].kind === "own" ? [r1, r2] : [r2, r1];
    expect(await loser.send("link")).toEqual({ refused: "no-authority" });
    expect(await winner.send("link")).toEqual({ linked: "linked" });
    expect(await winner.send("t2", t2Args(s))).toEqual({ committed: true });
    expect(linkAttempts(trace, loser.name)).toEqual([]); noViolations();
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
  });

  run("S4: lost T1 acknowledgement before any link: same token regains authority, missing links done, one T2", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    expect(await a.send("t1", { lostAck: true })).toEqual({ lostAck: true });
    const [intent] = await intentRows(s.op.id); // parent's own read after the reply barrier
    expect(intent.state).toBe("authorized");
    expect(await a.send("link")).toEqual({ refused: "no-authority" }); // no confirmed authority -> no link
    expect((await a.send("t1")).kind).toBe("own");
    expect(await a.send("link")).toEqual({ linked: "linked" });
    expect(await a.send("t2", t2Args(s))).toEqual({ committed: true });
    expect((await intentRows(s.op.id)).length).toBe(1); noViolations();
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
  });

  run("S4b: concurrent lost-T1-ack retries by two callers yield one executor", async () => {
    const productId = await product(), a = await spawnActor("A"), a2 = await spawnActor("A2");
    const s = await sealed(a, productId);
    await a2.send("adopt", { op: s.op, seal: s.seal.seal });
    expect(await Promise.all([a.send("t1", { lostAck: true }), a2.send("t1", { lostAck: true })])).toEqual([{ lostAck: true }, { lostAck: true }]);
    const retries = await Promise.all([a.send("t1"), a2.send("t1")]);
    expect(retries.map((x) => x.kind).sort()).toEqual(["held-by-other", "own"]);
    const [winner, loser] = retries[0].kind === "own" ? [a, a2] : [a2, a];
    expect(await loser.send("link")).toEqual({ refused: "no-authority" });
    expect(await winner.send("link")).toEqual({ linked: "linked" });
    expect(await winner.send("t2", t2Args(s))).toEqual({ committed: true });
    expect(linkAttempts(trace, loser.name)).toEqual([]); noViolations();
    expect((await intentRows(s.op.id)).length).toBe(1);
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
  });

  run("S4c: a same-token T1 retry is idempotent", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    const before = await intentRows(s.op.id);
    expect((await a.send("t1")).kind).toBe("own");
    expect(await intentRows(s.op.id)).toEqual(before);
  });

  run("S5: SIGKILL between main and thumb links; resume keeps main, links thumb, one T2", async () => {
    const productId = await product(), a = await spawnActor("A"), r = await spawnActor("R");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    expect(await a.send("linkOne", { artifact: "main" })).toEqual({ linked: "main" });
    const mainBefore = await lstat(path.join(canonical, s.op.mainKey), { bigint: true });
    await observeExitAndReceipt(a, s.op.id, 1);
    expect((await r.send("transfer", { operationId: s.op.id, expectedEpoch: 1 })).kind).toBe("own");
    expect(await r.send("link")).toEqual({ linked: "linked" });
    expect(await r.send("t2", t2Args(s))).toEqual({ committed: true });
    const mainAfter = await lstat(path.join(canonical, s.op.mainKey), { bigint: true });
    expect([mainAfter.dev, mainAfter.ino]).toEqual([mainBefore.dev, mainBefore.ino]);
    expect(linkAttempts(trace, "R").map((e) => path.basename(e.data.dst))).toEqual([s.op.thumbKey]); noViolations();
    await expectCanonicalMatchesIntent(s.op.id);
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
  });

  run("S6: lost T2 acknowledgement returns the committed result with no new effects or links", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    await a.send("link", { mode: "real" });
    expect(await a.send("t2", { ...t2Args(s), lostAck: true })).toEqual({ lostAck: true });
    expect(await a.send("t2", t2Args(s))).toMatchObject({ committed: true, already: true });
    expect(await effects(s.op.photoId)).toEqual([1, 1]);
    expect(linkAttempts(trace, "A").length).toBe(2); noViolations();
  });

  run("S7: a foreign canonical inode leads to review, untouched, with no T2", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    expect((await a.send("t1")).kind).toBe("own");
    const foreign = path.join(canonical, s.op.mainKey);
    await writeFile(foreign, "foreign-evidence");
    expect(await a.send("link")).toEqual({ linked: "review" });
    expect(await readFile(foreign, "utf8")).toBe("foreign-evidence");
    expect((await opRow(s.op.id)).state).toBe("review");
    expect((await intentRows(s.op.id))[0].state).toBe("review");
    await expect(a.send("t2", t2Args(s))).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST");
    expect(await effects(s.op.photoId)).toEqual([0, 0]);
  });

  run("S8: database closed before T1 fails closed with no link", async () => {
    const productId = await product(), a = await spawnActor("A");
    const s = await sealed(a, productId);
    await a.send("closeDb");
    await expect(a.send("t1")).rejects.toBeTruthy();
    expect(await a.send("link")).toEqual({ refused: "no-authority" });
    expect(linkAttempts(trace, "A")).toEqual([]);
    expect(await intentRows(s.op.id)).toEqual([]);
  });

  run("UNIQUE: a forced unique violation recovers via savepoint, never queries an aborted transaction", async () => {
    const shared = randomUUID();
    const z = await spawnActor("Z", { F2C1_TOKEN: shared }), a = await spawnActor("A", { F2C1_TOKEN: shared });
    const sz = await sealed(z, await product());
    expect((await z.send("t1")).kind).toBe("own"); // occupies UNIQUE(executor_token) for another operation
    const s = await sealed(a, await product());
    const result = await a.send("t1"); // INSERT violates UNIQUE(executor_token) -> ROLLBACK TO SAVEPOINT -> re-select
    expect(result).toEqual({ kind: "rejected", reason: "unique violation without an intent for this operation" });
    expect(await intentRows(s.op.id)).toEqual([]);
    expect((await opRow(s.op.id)).state).toBe("sealed");
    expect((await intentRows(sz.op.id)).length).toBe(1);
    expect(await a.send("link")).toEqual({ refused: "no-authority" });
  });
});
