/**
 * FAZ A / #424 W2 generation-fenced owner: stale writers, crash recovery, lost acknowledgement and concurrent
 * duplicates on real SQLite and (when POSTGRES_TEST_DATABASE_URL is a disposable database) real PostgreSQL.
 * Real files, real image recipe, real photo/outbox transaction with the generation CAS.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { simulatedPersistentRemount } from "./fixtures/persistentRemount";
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
      const harness = await createPostgresTestDb("0044_photo_publication_copies.sql");
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
    // #472: the crashed execution has provably ended in this process (execution registry), so the retry transfers the
    // durable publication intent (epoch 2) and adopts the recorded copies; it never waits for or depends on the lease.
    const recovered = await upload(token, back);
    const record = await op(token);
    expect(record).toMatchObject({ state: "committed", committed_photo_id: recovered.id });
    expect(Number(record.generation)).toBe(1);
    expect(await n("product_photos", `WHERE id = '${recovered.id}'`)).toBe(1);
    expect(await n("outbox_events", `WHERE aggregate_id = '${recovered.id}'`)).toBe(1);
    expect(await Promise.all([record.main_key, record.thumb_key].map(async (key) => (await lstat(path.join(root, "photos", key))).ino))).toEqual(published);
    const [intent] = await q(sql`SELECT state, executor_epoch FROM photo_publication_intents WHERE operation_id = ${record.id}`);
    expect([intent.state, Number(intent.executor_epoch)]).toEqual(["committed", 2]);
    const [exit] = await q(sql`SELECT attested_by FROM photo_executor_exit_records WHERE operation_id = ${record.id} AND executor_epoch = 1`);
    expect(String(exit.attested_by)).toMatch(/^self-ended:/);
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

  // #472: adoption is keyed to the durably recorded publisher-owned copy, never to a private (worker) name. A missing or
  // replaced private name therefore neither authorizes nor blocks adopting the operation's own recorded copy.
  it.skipIf(!enabled).each(["missing", "replaced"] as const)("F3: a %s private name is never linked; recovery adopts only the recorded copy inode", async (mode) => {
    const token = `orphan-${mode}-${driver}-000001`;
    await expect(upload(token, front, { afterPublish: () => { throw new Error("crash retains canonical"); } })).rejects.toThrow("crash retains canonical");
    const record = await op(token), destination = path.join(root, "photos", record.main_key);
    const before = await lstat(destination, { bigint: true });
    const privateName = path.join(root, ".product-photo-operations", record.id, "1", "main.webp");
    await rm(privateName);
    if (mode === "replaced") await copyFile(destination, privateName);
    const replacedInode = mode === "replaced" ? (await lstat(privateName, { bigint: true })).ino : undefined;
    await expire(token);
    const recovered = await upload(token, front);
    expect(await op(token)).toMatchObject({ state: "committed", committed_photo_id: recovered.id });
    expect(Number((await op(token)).generation)).toBe(1); // no reclaim after T1, whatever the lease says
    const after = await lstat(destination, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    if (replacedInode !== undefined) expect(replacedInode).not.toBe(after.ino); // the replaced private name was never linked
    const [copy] = await q(sql`SELECT copy_ino FROM photo_publication_copies WHERE operation_id = ${record.id} AND artifact = 'main'`);
    expect(String(copy.copy_ino)).toBe(String(after.ino));
    expect(await n("product_photos", `WHERE id = '${record.target_photo_id}'`)).toBe(1);
  });

  /** Runs A until it sealed, lets B reclaim (expired lease) and seal generation 2, then parks B before its T1. */
  async function staleRace(token: string, afterReclaim: () => Promise<void>, hooks: FencedUploadHooks = {}) {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let winner: Promise<any> | undefined;
    const stale = upload(token, front, {
      ...hooks,
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
        await afterReclaim();
      },
    });
    return { stale, release: () => release(), winner: () => winner! };
  }

  // INVERTED original reproduction (was "REPRO F2 SECURITY FAIL"): the stale owner A is rejected at T1 and never
  // creates a canonical name; B publishes its own verified copy and commits exactly once.
  it.skipIf(!enabled)("F2 REMEDIATED: stale W2 A cannot create a canonical name while reclaimed B is sealed but has not published", async () => {
    const token = `stale-before-b-${driver}-001`;
    let reachedPublication = false;
    const race = await staleRace(token, async () => undefined, { afterIntent: () => { reachedPublication = true; }, copyPhase: () => { reachedPublication = true; } });
    try {
      await expect(race.stale).rejects.toMatchObject({ status: 503, code: "PHOTO_OPERATION_FENCE_LOST" });
      expect(reachedPublication).toBe(false);
      const parked = await op(token);
      await expect(lstat(path.join(root, "photos", parked.main_key))).rejects.toMatchObject({ code: "ENOENT" }); // A created nothing
      await expect(lstat(path.join(root, "photos", parked.thumb_key))).rejects.toMatchObject({ code: "ENOENT" });
      race.release();
      const recovered = await race.winner();
      const record = await op(token);
      expect([Number(record.generation), record.state]).toEqual([2, "committed"]);
      const canonical = await lstat(path.join(root, "photos", record.main_key), { bigint: true });
      expect(canonical.nlink).toBe(1n); // publisher-owned copy: no worker/private alias exists
      const [copy] = await q(sql`SELECT copy_ino FROM photo_publication_copies WHERE operation_id = ${record.id} AND artifact = 'main'`);
      expect(String(copy.copy_ino)).toBe(String(canonical.ino));
      const [intent] = await q(sql`SELECT generation, state FROM photo_publication_intents WHERE operation_id = ${record.id}`);
      expect([Number(intent.generation), intent.state]).toEqual([2, "committed"]);
      expect(await n("product_photos", `WHERE id = '${recovered.id}'`)).toBe(1);
      expect(await n("outbox_events", `WHERE aggregate_id = '${recovered.id}'`)).toBe(1);
    } finally { race.release(); await race.winner()?.catch(() => undefined); }
  });

  // NEGATIVE CONTROL (sensitivity): the same race with the legacy worker-inode primitive still links the stale private
  // inode, so the assertions above would detect a regression to it. No runtime owner calls this primitive.
  it.skipIf(!enabled)("NEGATIVE CONTROL: the legacy publishSealedArtifacts primitive still lets stale A link before B", async () => {
    const token = `stale-legacy-${driver}-001`;
    const { publishSealedArtifacts } = await import("../src/services/photoOperationAuthority");
    let staleInode = "";
    const race = await staleRace(token, async () => {
      const record = await op(token);
      const [g1] = await q(sql`SELECT owner, nonce FROM photo_operation_generations WHERE operation_id = ${record.id} AND generation = 1`);
      const [seal] = await q(sql`SELECT main_sha256, thumb_sha256, main_bytes, thumb_bytes, main_dev, main_ino, thumb_dev, thumb_ino FROM photo_operation_artifacts WHERE operation_id = ${record.id} AND generation = 1`);
      const dir = path.join(root, ".product-photo-operations", record.id, "1");
      const proof = (a: "main" | "thumb") => ({ sha256: seal[a + "_sha256"], bytes: Number(seal[a + "_bytes"]), dev: String(seal[a + "_dev"]), ino: String(seal[a + "_ino"]) });
      await publishSealedArtifacts(db, driver, { id: record.id, generation: 1, owner: g1.owner, nonce: g1.nonce, photoId: record.target_photo_id, mainKey: record.main_key, thumbKey: record.thumb_key },
        { main: path.join(dir, "main.webp"), thumb: path.join(dir, "thumb.webp") }, { main: proof("main"), thumb: proof("thumb") }, path.join(root, "photos"));
      const privateA = await lstat(path.join(dir, "main.webp"), { bigint: true }), canonical = await lstat(path.join(root, "photos", record.main_key), { bigint: true });
      expect([canonical.dev, canonical.ino]).toEqual([privateA.dev, privateA.ino]); // the vulnerability shape, reproduced
      staleInode = String(canonical.ino);
    });
    try {
      await expect(race.stale).rejects.toMatchObject({ status: 503 });
      expect(staleInode).not.toBe("");
      race.release();
      // B now meets a canonical name that is not its recorded copy: protected publication refuses it (review).
      await expect(race.winner()).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_REVIEW" });
      expect((await op(token)).state).toBe("review");
      expect(String((await lstat(path.join(root, "photos", (await op(token)).main_key), { bigint: true })).ino)).toBe(staleInode);
    } finally { race.release(); await race.winner()?.catch(() => undefined); }
  });

  it.skipIf(!enabled)("private generation evidence never lives under the public static root", async () => {
    expect(await readdir(path.join(root, "photos"))).not.toContain(".product-photo-operations");
    expect((await readdir(root))).toContain(".product-photo-operations");
  });
  for (const phase of ["intent", "main", "thumb", "commit"] as const) it.skipIf(!enabled)("SIMULATED remount W2 recovery at " + phase, async () => {
    const simulation = simulatedPersistentRemount(); const token="pfs-"+phase+"-"+driver+"-"+randomUUID();
    const stop=()=>{simulation.replaceInstance();throw Error("simulated instance replacement");};
    try {
      const hooks:FencedUploadHooks=phase==="intent"?{afterIntent:stop}:phase==="commit"?{afterCommit:stop}:{copyPhase:(artifact,p)=>{if(artifact===phase&&p==="linked")stop();}};
      await expect(upload(token,front,hooks)).rejects.toThrow("simulated instance replacement");
      const result=await upload(token,front);expect((await upload(token,front)).id).toBe(result.id);
      expect(await n("product_photos",`WHERE id = '${result.id}'`)).toBe(1);expect(await n("outbox_events",`WHERE aggregate_id = '${result.id}'`)).toBe(1);
      const row=await op(token);expect(row.state).toBe("committed");expect(Number(row.generation)).toBe(1);
      const [seal]=await q(sql`SELECT main_dev FROM photo_operation_artifacts WHERE operation_id = ${row.id}`);expect(seal.main_dev).toMatch(/^pfs1:/);
      const [intent]=await q(sql`SELECT executor_epoch FROM photo_publication_intents WHERE operation_id = ${row.id}`);expect(Number(intent.executor_epoch)).toBe(phase==="commit"?1:2);
    } finally { simulation.restore(); }
  });

});
