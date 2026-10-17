/** #457 independent evidence. REPRO passes mean a vulnerability was reproduced, NEVER security acceptance. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
const audit = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "noctella-codex-w11-457-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DIR: p.join(root, "default-photos"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" });
  return { root, statSwap: undefined as undefined | ((file: string) => void), writeFault: undefined as undefined | ((file: string) => void), linkFault: undefined as undefined | (() => void) };
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => { const info = await fs.lstat(...args); audit.statSwap?.(String(args[0])); return info; }, writeFile: async (...args: Parameters<typeof fs.writeFile>) => { audit.writeFault?.(String(args[0])); return fs.writeFile(...args); },
    link: async (...args: Parameters<typeof fs.link>) => { audit.linkFault?.(); return fs.link(...args); } };
});
import * as fs from "node:fs";
import { lstat, mkdir, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { fileProof, photoOperationPrivateRoot } from "../src/services/photoOperationAuthority";
import { prepareFencedInstagramDerivative, type W11Hooks } from "../src/services/w11FencedInstagramDerivativeOwner";
import { prepareInstagramImageAsset, renderInstagramDerivative, sourceFingerprint } from "../src/integrations/instagram/mediaPreparation";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
const ddl = fs.readFileSync(path.resolve(__dirname, "../../../docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal"), "utf8").split("\n").filter(l => !l.trim().startsWith("--")).join("\n").split(";").map(s => s.trim()).filter(Boolean);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => { audit.statSwap = undefined; audit.writeFault = undefined; audit.linkFault = undefined; process.env.PHOTO_OWNERSHIP_FENCING_ENABLED = "true"; });
afterAll(async () => {
  const resolved = path.resolve(audit.root);
  if (!resolved.startsWith(path.resolve(require("node:os").tmpdir()) + path.sep) || !path.basename(resolved).startsWith("noctella-codex-w11-457-")) throw new Error("unsafe test cleanup");
  await rm(resolved, { recursive: true, force: true });
});
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("required PostgreSQL evidence cannot silently skip", () => expect(postgresTestConfigured).toBe(true));
it("REPRO F1: real pathname swap returns hash of B with stat identity and size of A", async () => {
  const file = path.join(audit.root, "proof-a"); await writeFile(file, "A"); const old = await lstat(file);
  audit.statSwap = name => { if (name !== file) return; audit.statSwap = undefined; fs.renameSync(file, file + ".old"); fs.writeFileSync(file, "replacement-B"); };
  const proof = await fileProof(file), current = await lstat(file);
  expect(proof.sha256).toBe(createHash("sha256").update("replacement-B").digest("hex"));
  expect(proof.bytes).toBe(1); expect(proof.ino).toBe(String(old.ino)); expect(proof.ino).not.toBe(String(current.ino));
});
it("REPRO F4: fencing-OFF live entry maps EIO to permanent invalid_media", async () => {
  const root = path.join(audit.root, "live-io"); await mkdir(root);
  await writeFile(path.join(root, "a.webp"), await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).webp().toBuffer());
  process.env.PHOTO_OWNERSHIP_FENCING_ENABLED = "false";
  audit.writeFault = file => { if (path.basename(file).startsWith(".instagram-")) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); };
  await expect(prepareInstagramImageAsset({ url: "/images/product-photos/a.webp" }, "https://api.synthetic.test", { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.synthetic.test" }, root)).rejects.toMatchObject({ kind: "invalid_media", retryable: false });
  expect(await readdir(root)).toEqual(["a.webp"]);
});
it("fencing ON still refuses before filesystem I/O", async () => {
  audit.writeFault = () => { throw new Error("must never write"); };
  await expect(prepareInstagramImageAsset({ url: "/images/product-photos/missing.webp" }, "https://api.synthetic.test")).rejects.toMatchObject({ kind: "processing", retryable: true });
});
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("inactive owner evidence: %s", (driver, enabled) => {
  let db: any, raw: Database.Database | undefined, close = async () => {}, root: string, source: Buffer;
  let input: { sourceKey: string; source: Buffer; recipeId: "instagram-v1" };
  const q = async (s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;
  const key = () => `instagram-v1-${sourceFingerprint(input.sourceKey, input.source)}.jpg`, dest = () => path.join(root, key());
  const row = async () => (await q(sql`SELECT * FROM photo_derivative_operations WHERE derivative_key = ${key()}`))[0];
  const expire = () => q(sql`UPDATE photo_derivative_operations SET lease_until_ms = 0 WHERE derivative_key = ${key()} RETURNING id`);
  const prepare = (hooks?: W11Hooks, client = db) => prepareFencedInstagramDerivative(client, input, { driver, canonicalRoot: root, hooks });
  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") { const h = await createPostgresTestDb("0038_background_job_claim_fencing.sql"); db = h.db; close = () => h.close(); }
    else { raw = new Database(":memory:"); raw.pragma("foreign_keys=ON"); db = drizzle(raw); close = async () => { raw!.close(); }; }
    for (const s of ddl) { if (driver === "sqlite") raw!.exec(s); else await db.execute(sql.raw(s)); }
    source = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#214365" } }).webp().toBuffer();
  });
  beforeEach(async () => { if (!enabled) return; root = path.join(audit.root, driver, randomUUID(), "photos"); await mkdir(root, { recursive: true }); input = { sourceKey: `${randomUUID()}.webp`, source, recipeId: "instagram-v1" }; });
  afterAll(async () => { await close(); });
  it.skipIf(!enabled)("concurrent same-key claims reject active duplicates", async () => {
    const sealed = deferred(), release = deferred(); const first = prepare({ afterSeal: async () => { sealed.resolve(); await release.promise; } });
    await sealed.promise;
    try { const others = await Promise.allSettled([prepare(), prepare()]); expect(others.every(r => r.status === "rejected" && r.reason.code === "W11_OPERATION_IN_PROGRESS")).toBe(true); } finally { release.resolve(); }
    expect(await first).toBe(key()); expect((await row()).state).toBe("committed");
  });
  it.skipIf(!enabled)("conflicting persisted fingerprint fails closed", async () => {
    await expect(prepare({ afterSeal: () => { throw new Error("interrupt"); } })).rejects.toThrow("interrupt");
    await q(sql`UPDATE photo_derivative_operations SET source_fingerprint = ${"f".repeat(64)} WHERE derivative_key = ${key()} RETURNING id`);
    await expect(prepare()).rejects.toMatchObject({ code: "W11_OPERATION_CONFLICT" }); expect(await readdir(root)).toEqual([]);
  });
  it.skipIf(!enabled)("REPRO F2: replaced owner publishes first then loses commit CAS", async () => {
    const bSealed = deferred(), releaseB = deferred(); let b: Promise<string> | undefined, aIno = "";
    const a = prepare({ afterSeal: async () => { aIno = (await row()).seal_ino; await expire(); b = prepare({ afterSeal: async () => { bSealed.resolve(); await releaseB.promise; } }); await bSealed.promise; } });
    try { await expect(a).rejects.toMatchObject({ code: "W11_OPERATION_FENCE_LOST" }); const current = await row(); expect(Number(current.generation)).toBe(2); expect(current.state).toBe("sealed"); expect(String((await lstat(dest())).ino)).toBe(aIno); expect(current.seal_ino).not.toBe(aIno); }
    finally { releaseB.resolve(); if (b) await b; }
    expect((await row()).state).toBe("committed");
  });
  it.skipIf(!enabled)("REPRO F3: same-byte foreign inode commits without generation provenance", async () => {
    await writeFile(dest(), await renderInstagramDerivative(source, "instagram-v1"), { flag: "wx" }); const foreign = await lstat(dest());
    expect(await prepare()).toBe(key()); const op = await row(); expect(op.state).toBe("committed"); expect(op.seal_ino).not.toBe(String(foreign.ino)); expect((await lstat(dest())).ino).toBe(foreign.ino);
  });
  it.skipIf(!enabled)("REPRO F1: private ancestor symlink or junction escapes intended root", async () => {
    const outside = path.join(audit.root, `outside-${randomUUID()}`); await mkdir(outside); await symlink(outside, photoOperationPrivateRoot(root), process.platform === "win32" ? "junction" : "dir");
    expect(await prepare()).toBe(key()); const op = await row(); expect(await readdir(path.join(outside, "derivatives", op.id))).toEqual(["1"]); expect(op.state).toBe("committed");
  });
  it.skipIf(!enabled)("seal interruption retains evidence and expired retry recovers", async () => {
    await expect(prepare({ afterSeal: () => { throw new Error("interrupt-seal"); } })).rejects.toThrow("interrupt-seal"); expect((await row()).state).toBe("sealed"); expect(await readdir(root)).toEqual([]);
    await expect(prepare()).rejects.toMatchObject({ code: "W11_OPERATION_IN_PROGRESS" }); await expire(); expect(await prepare()).toBe(key()); expect(Number((await row()).generation)).toBe(2);
  });
  it.skipIf(!enabled)("publication interruption recovers without replacing canonical inode", async () => {
    await expect(prepare({ afterPublish: () => { throw new Error("interrupt-publish"); } })).rejects.toThrow("interrupt-publish"); const inode = (await lstat(dest())).ino;
    await expire(); expect(await prepare()).toBe(key()); expect((await lstat(dest())).ino).toBe(inode);
  });
  it.skipIf(!enabled)("lost transaction response after real commit recovers idempotently", async () => {
    let injected = false; const lost = () => { injected = true; throw new Error("synthetic lost SQL commit response"); };
    const client = new Proxy(db, { get(target, property) { if (property !== "transaction") return Reflect.get(target, property); return (...args: any[]) => {
      const result = target.transaction(...args);
      if (driver === "postgres") return result.then(async (value: any) => { if (!injected && (await row())?.state === "committed") lost(); return value; });
      if (!injected && (raw!.prepare("SELECT state FROM photo_derivative_operations WHERE derivative_key=?").get(key()) as any)?.state === "committed") lost(); return result;
    }; } });
    await expect(prepare(undefined, client)).rejects.toThrow("lost SQL commit response"); expect(injected).toBe(true); expect((await row()).state).toBe("committed");
    const inode = (await lstat(dest())).ino; expect(await prepare()).toBe(key()); expect((await lstat(dest())).ino).toBe(inode);
  });
  it.skipIf(!enabled)("missing committed derivative is flagged never rewritten", async () => {
    await prepare(); await unlink(dest()); await expect(prepare()).rejects.toMatchObject({ code: "W11_OPERATION_REVIEW" }); expect((await row()).review_reason).toContain("missing"); expect(await readdir(root)).toEqual([]);
  });
  it.skipIf(!enabled)("injected ENOSPC fails before seal and canonical publication", async () => {
    audit.writeFault = file => { if (file.endsWith("derivative.jpg")) throw Object.assign(new Error("synthetic ENOSPC"), { code: "ENOSPC" }); };
    await expect(prepare()).rejects.toMatchObject({ code: "ENOSPC" }); expect((await row()).state).toBe("preparing"); expect(await readdir(root)).toEqual([]);
  });
  it.skipIf(!enabled)("injected EIO at link retains sealed operation and recovers after expiry", async () => {
    audit.linkFault = () => { throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); };
    await expect(prepare()).rejects.toMatchObject({ code: "EIO" }); expect((await row()).state).toBe("sealed"); expect(await readdir(root)).toEqual([]);
    audit.linkFault = undefined; await expire(); expect(await prepare()).toBe(key());
  });
  it.skipIf(!enabled)("actual missing proposal tables fail closed on a fresh disposable database", async () => {
    let missing: any, finish = async () => {};
    if (driver === "postgres") { const h = await createPostgresTestDb("0038_background_job_claim_fencing.sql"); missing = h.db; finish = () => h.close(); }
    else { const empty = new Database(":memory:"); missing = drizzle(empty); finish = async () => { empty.close(); }; }
    try { await expect(prepare(undefined, missing)).rejects.toThrow(); expect(await readdir(root)).toEqual([]); expect(await readdir(path.dirname(root))).toEqual(["photos"]); }
    finally { await finish(); }
  });
  it.skipIf(!enabled)("different source bytes produce separate immutable keys and histories preserve nonce uniqueness", async () => {
    await prepare(); const first = key(); input.source = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#654321" } }).webp().toBuffer();
    const second = await prepare(); expect(second).not.toBe(first);
    const history = await q(sql`SELECT operation_id, generation, nonce FROM photo_derivative_operation_generations WHERE operation_id = ${(await row()).id}`);
    expect(history).toHaveLength(1);
    const h = history[0]; await expect(q(sql`INSERT INTO photo_derivative_operation_generations (operation_id,generation,owner,nonce,state,created_ms,updated_ms) VALUES (${h.operation_id},2,'foreign',${h.nonce},'active',0,0) RETURNING operation_id`)).rejects.toThrow();
  });
});




