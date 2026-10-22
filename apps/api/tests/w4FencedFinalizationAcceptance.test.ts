/**
 * FAZ A / #424 combined W2 + W4 acceptance with PHOTO_OWNERSHIP_FENCING_ENABLED=true on real SQLite and (when
 * POSTGRES_TEST_DATABASE_URL is a disposable database) real PostgreSQL: the real W4 finalization service and
 * transaction, the real W2 owner, the shared photo-operation authority, real files and the real image recipe.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { expectRetainedPublication } from "./fixtures/retainedPublication";
import { simulatedPersistentRemount, publicationSnapshot, recordRemountEvidence } from "./fixtures/persistentRemount";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-w4-fenced-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  return { root };
});

import { createTestDb } from "./testDb";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { finalizeAiIntakePhotos } from "../src/services/aiIntakePhotoFinalization";
import { listPhotoOperationsRequiringRecovery } from "../src/services/photoOperationAuthority";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";
import type { W4FencedOptions } from "../src/services/w4FencedFinalizationOwner";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
afterAll(async () => {
  // Sharp metadata probes can retain cached file handles on Windows; release them before disposable fixture teardown.
  sharp.cache(false);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

type Driver = "sqlite" | "postgres";
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as Array<[Driver, boolean]>)("fenced W2 + W4 on %s", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {}, categoryId: string;
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const sources = new Map<string, Buffer>();
  const q = async (statement: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(statement) : (await db.execute(statement)).rows);
  const n = async (statement: SQL) => Number((await q(statement))[0].n);
  const legacyWriter = vi.fn(async () => { throw new Error("the unfenced canonical writer must never run with fencing ON"); });
  const deps = { readStagedPhotoBytes: async (id: string) => { const b = sources.get(id); if (!b) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return b; }, writeDeterministicPhoto: legacyWriter as any };
  const finalize = (intakeId: string, options: W4FencedOptions = {}) => finalizeAiIntakePhotos(db, intakeId, {}, "admin-finalizer", deps, { driver, ...options });
  const expireAll = () => q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE state IN ('preparing', 'sealed') RETURNING id`);
  const jpeg = (r: number, g: number) => sharp({ create: { width: 160, height: 100, channels: 3, background: { r, g, b: 90 } } }).jpeg().toBuffer();

  async function product() {
    const id = randomUUID();
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${id}, ${"W4-" + id}, 'Synthetic', ${"w4-" + id}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
    return id;
  }
  /** An Applied intake with a Draft result product and `count` staged photos (real JPEG sources). */
  async function appliedIntake(count: number) {
    const productId = await product(), intakeId = randomUUID(), stagedIds: string[] = [];
    await q(sql`INSERT INTO ai_product_intakes (id, status, created_by_admin_user_id, result_product_id, applied_at, applied_by_admin_user_id) VALUES (${intakeId}, ${AiProductIntakeStatus.Applied}, 'admin-1', ${productId}, ${new Date().toISOString()}, 'admin-1') RETURNING id`);
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      stagedIds.push(id);
      sources.set(id, await jpeg(40 + i * 60, 200 - i * 50));
      await q(sql`INSERT INTO ai_intake_photos (id, intake_id, storage_key, original_filename, created_by_admin_user_id, created_at, updated_at) VALUES (${id}, ${intakeId}, ${randomUUID() + ".webp"}, ${"photo-" + i + ".jpg"}, 'admin-1', ${new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()}, ${new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()}) RETURNING id`);
    }
    return { productId, intakeId, stagedIds };
  }
  const ops = (ids: string[]) => q(sql`SELECT id, subject_id, kind, state, generation, main_key, thumb_key, committed_photo_id FROM photo_operations WHERE subject_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) ORDER BY subject_id`);
  const counts = async (productId: string) => [
    await n(sql`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = ${productId}`),
    await n(sql`SELECT COUNT(*) AS n FROM outbox_events WHERE aggregate_id IN (SELECT id FROM product_photos WHERE product_id = ${productId})`),
  ];
  const intakeStatus = async (intakeId: string) => (await q(sql`SELECT status FROM ai_product_intakes WHERE id = ${intakeId}`))[0].status;
  const inode = async (key: string) => (await lstat(path.join(root, "photos", key))).ino;

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      // Same pattern as the existing PostgreSQL runtime tests: config validation needs the URL; queries use `db`.
      process.env.DATABASE_DRIVER = "postgres";
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const harness = await createPostgresTestDb("0044_photo_publication_copies.sql");
      db = harness.db; close = () => harness.close();
    } else {
      delete process.env.DATABASE_DRIVER;
      db = createTestDb();
    }
    categoryId = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, ${"W4 " + driver}, ${"w4-" + categoryId}) RETURNING id`);
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it.skipIf(!enabled)("finalization commits exactly one fenced operation, photo and outbox event per staged photo, and finalizes the intake", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(2);
    const result = await finalize(intakeId);
    expect(result.created).toBe(true);
    expect(legacyWriter).not.toHaveBeenCalled();
    const rows = await ops(stagedIds);
    expect(rows.map((r) => [r.kind, r.state, Number(r.generation)])).toEqual([["ai_finalize", "committed", 1], ["ai_finalize", "committed", 1]]);
    for (const r of rows) {
      expect(r.committed_photo_id).toBe(r.subject_id);
      expect(r.main_key).toBe(`${productId}-${r.subject_id}.webp`);
      expect((await sharp(path.join(root, "photos", r.main_key)).metadata()).format).toBe("webp");
      await expectRetainedPublication(root, r, q);
    }
    expect(await counts(productId)).toEqual([2, 2]);
    expect(await intakeStatus(intakeId)).toBe(AiProductIntakeStatus.Finalized);
    const photos = await q(sql`SELECT id, is_primary, sort_order FROM product_photos WHERE product_id = ${productId} ORDER BY sort_order`);
    expect(photos.map((p) => [p.id, Number(p.sort_order), Boolean(Number(p.is_primary) || p.is_primary === true)])).toEqual([[stagedIds[0], 0, true], [stagedIds[1], 1, false]]);
  });

  it.skipIf(!enabled)("a retry after a lost acknowledgement is idempotent: no new operations, photos, events or files", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    await finalize(intakeId);
    const files = (await readdir(path.join(root, "photos"))).length;
    const again = await finalize(intakeId);
    expect(again.created).toBe(false);
    expect(await counts(productId)).toEqual([1, 1]);
    expect((await ops(stagedIds)).map((r) => r.state)).toEqual(["committed"]);
    expect((await readdir(path.join(root, "photos"))).length).toBe(files);
    for (const row of await ops(stagedIds)) await expectRetainedPublication(root, row, q);
  });

  // #472: the crashed execution provably ended in this process, so the retry transfers both durable intents (epoch 2)
  // and adopts the recorded copies at once; the lease is irrelevant after T1 and no generation is reclaimed.
  it.skipIf(!enabled)("a crash after canonical publication commits nothing, keeps evidence, and a retry finalizes exactly once by adopting the recorded copies", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(2);
    await expect(finalize(intakeId, { hooks: { afterPublish: (id) => { if (id === stagedIds[1]) throw new Error("simulated crash after publish"); } } })).rejects.toThrow("simulated crash");
    expect((await ops(stagedIds)).map((r) => r.state)).toEqual(["sealed", "sealed"]);
    expect(await counts(productId)).toEqual([0, 0]);
    expect(await intakeStatus(intakeId)).toBe(AiProductIntakeStatus.Applied);
    const before = await Promise.all((await ops(stagedIds)).flatMap((r) => [inode(r.main_key), inode(r.thumb_key)]));
    expect((await finalize(intakeId)).created).toBe(true);
    const rows = await ops(stagedIds);
    expect(rows.map((r) => [r.state, Number(r.generation)])).toEqual([["committed", 1], ["committed", 1]]);
    const intents = await Promise.all(rows.map(async (r) => (await q(sql`SELECT state, executor_epoch FROM photo_publication_intents WHERE operation_id = ${r.id}`))[0]));
    expect(intents.map((i) => [i.state, Number(i.executor_epoch)])).toEqual([["committed", 2], ["committed", 2]]);
    expect(await Promise.all(rows.flatMap((r) => [inode(r.main_key), inode(r.thumb_key)]))).toEqual(before);
    for (const row of rows) await expectRetainedPublication(root, row, q);
    expect(await counts(productId)).toEqual([2, 2]);
  });

  // RC2 #493 retained fixture: a Product that already had a photo was refused only inside the finalization transaction,
  // after T1 + copy publication, leaving an authorized intent and published copies. The refusal now happens first.
  it.skipIf(!enabled)("a Product that already has photos is refused before any intent, operation or canonical copy is created", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    await q(sql`INSERT INTO product_photos (id, product_id, url, thumbnail_url, filename, mime_type, size_bytes, width, height) VALUES (${randomUUID()}, ${productId}, '/images/product-photos/existing.webp', '/images/product-photos/existing-thumb.webp', 'existing.webp', 'image/webp', 1, 1, 1) RETURNING id`);
    const before = fs.existsSync(path.join(root, "photos")) ? fs.readdirSync(path.join(root, "photos")).sort() : [];
    await expect(finalize(intakeId)).rejects.toMatchObject({ name: "AiIntakePhotoFinalizationProductPhotosExistError" });
    await expect(finalize(intakeId)).rejects.toMatchObject({ name: "AiIntakePhotoFinalizationProductPhotosExistError" }); // retry: no epoch churn
    expect(await ops(stagedIds)).toEqual([]); // no operation, hence no generation, seal, intent or copy record
    expect(fs.existsSync(path.join(root, "photos")) ? fs.readdirSync(path.join(root, "photos")).sort() : []).toEqual(before);
    expect(await intakeStatus(intakeId)).toBe(AiProductIntakeStatus.Applied);
  });

  it.skipIf(!enabled)("a crash after sealing (before publication) publishes nothing and recovers exactly once", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    await expect(finalize(intakeId, { hooks: { afterSeal: () => { throw new Error("simulated crash after seal"); } } })).rejects.toThrow("simulated crash");
    const [sealed] = await ops(stagedIds);
    expect(sealed.state).toBe("sealed");
    await expect(lstat(path.join(root, "photos", sealed.main_key))).rejects.toMatchObject({ code: "ENOENT" });
    await expireAll();
    expect((await finalize(intakeId)).created).toBe(true);
    expect(await counts(productId)).toEqual([1, 1]);
  });

  // #472: after T1 an expired lease no longer lets another finalizer reclaim: the publishing executor is alive in this
  // process, so the second finalizer is refused (BLOCKED) and the original commits exactly once.
  it.skipIf(!enabled)("an expired lease cannot hand an actively publishing finalization to another finalizer; no duplicate effects", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    let second: unknown;
    const first = await finalize(intakeId, { hooks: { afterPublish: async () => { await expireAll(); second = await finalize(intakeId).catch((e) => e); } } });
    expect(second).toMatchObject({ status: 409, code: "PHOTO_OPERATION_IN_PROGRESS" });
    expect(first.created).toBe(true);
    const [row] = await ops(stagedIds);
    expect([row.state, Number(row.generation)]).toEqual(["committed", 1]);
    expect(await counts(productId)).toEqual([1, 1]);
  });

  // INVERTED F2 shape for W4: a finalizer stalled after sealing (before T1) is superseded; it is rejected at T1 and
  // never creates a canonical name. The winner publishes its own recorded copies and finalizes exactly once.
  it.skipIf(!enabled)("F2 REMEDIATED (W4): a stale finalizer superseded before T1 never creates a canonical name", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    let winner: any, publishedByStale = false;
    await expect(finalize(intakeId, { hooks: {
      afterSeal: async () => { await expireAll(); winner = await finalize(intakeId); },
      copyPhase: () => { publishedByStale = true; },
    } })).rejects.toMatchObject({ status: 503, code: "PHOTO_OPERATION_FENCE_LOST" });
    expect(publishedByStale).toBe(false);
    expect(winner.created).toBe(true);
    const [row] = await ops(stagedIds);
    expect([row.state, Number(row.generation)]).toEqual(["committed", 2]);
    for (const artifact of ["main", "thumb"] as const) {
      const canonical = await lstat(path.join(root, "photos", row[artifact + "_key"]), { bigint: true });
      const [copy] = await q(sql`SELECT copy_ino FROM photo_publication_copies WHERE operation_id = ${row.id} AND artifact = ${artifact}`);
      expect([String(copy.copy_ino), canonical.nlink]).toEqual([String(canonical.ino), 2n]);
    }
    expect(await counts(productId)).toEqual([1, 1]);
    expect(await intakeStatus(intakeId)).toBe(AiProductIntakeStatus.Finalized);
    await expectRetainedPublication(root, row, q);
  });

  it.skipIf(!enabled).each(["main", "thumb"] as const)("F3: W4 rejects foreign identical-byte %s canonical inode without finalizing", async (artifact) => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    let destination = "", foreignInode = "", foreignBytes: Buffer;
    await expect(finalize(intakeId, { hooks: { afterSeal: async () => {
      const [record] = await q(sql`SELECT id, generation, main_key, thumb_key FROM photo_operations WHERE subject_id = ${stagedIds[0]}`);
      const source = path.join(root, ".product-photo-operations", record.id, String(record.generation), artifact + ".webp");
      destination = path.join(root, "photos", record[artifact + "_key"]);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      foreignBytes = await readFile(destination);
      foreignInode = String((await lstat(destination, { bigint: true })).ino);
      expect(foreignInode).not.toBe(String((await lstat(source, { bigint: true })).ino));
    } } })).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_REVIEW" });
    expect((await ops(stagedIds))[0].state).toBe("review");
    expect(await counts(productId)).toEqual([0, 0]);
    expect(await intakeStatus(intakeId)).toBe(AiProductIntakeStatus.Applied);
    expect(String((await lstat(destination, { bigint: true })).ino)).toBe(foreignInode);
    expect(await readFile(destination)).toEqual(foreignBytes!);
  });

  it.skipIf(!enabled)("a changed staged source never reuses an existing operation (409, nothing committed)", async () => {
    const { productId, intakeId, stagedIds } = await appliedIntake(1);
    await expect(finalize(intakeId, { hooks: { afterSeal: () => { throw new Error("crash"); } } })).rejects.toThrow("crash");
    sources.set(stagedIds[0], await jpeg(1, 2));
    await expireAll();
    await expect(finalize(intakeId)).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_CONFLICT" });
    expect(await counts(productId)).toEqual([0, 0]);
  });

  it.skipIf(!enabled)("concurrent finalizations of one intake produce exactly one set of effects", async () => {
    const { productId, intakeId } = await appliedIntake(2);
    const results = await Promise.allSettled([finalize(intakeId), finalize(intakeId), finalize(intakeId)]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409 });
    expect(ok.filter((r) => r.value.created).length).toBeLessThanOrEqual(1);
    const counted = await counts(productId);
    expect([[0, 0], [2, 2]]).toContainEqual(counted);
    if (counted[0] === 0) { await expireAll(); expect((await finalize(intakeId)).created).toBe(true); }
    expect(await counts(productId)).toEqual([2, 2]);
  });

  it.skipIf(!enabled)("#458: with no explicit driver, W2 and W4 route from DATABASE_DRIVER (incl. supabase-postgres) and commit", async () => {
    const runtimeValues = driver === "postgres" ? ["postgres", "supabase-postgres"] : [undefined, "sqlite"];
    const before = process.env.DATABASE_DRIVER, beforeSupabaseUrl = process.env.SUPABASE_DATABASE_URL;
    try {
      for (const value of runtimeValues) {
        if (value === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = value;
        // Runtime config validation requires a URL for this driver; point it at the same disposable test database
        // (queries still use the harness `db`; no Supabase access).
        if (value === "supabase-postgres") process.env.SUPABASE_DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
        const { productId, intakeId, stagedIds } = await appliedIntake(1);
        expect((await finalizeAiIntakePhotos(db, intakeId, {}, "admin-finalizer", deps, {})).created).toBe(true);
        expect((await ops(stagedIds)).map((r) => [r.kind, r.state])).toEqual([["ai_finalize", "committed"]]);
        expect(await counts(productId)).toEqual([1, 1]);
        const w2Product = await product(), workDir = await mkdtemp(path.join(os.tmpdir(), "noctella-w2-route-"));
        try {
          const bytes = await jpeg(20, 180);
          await writeFile(path.join(workDir, "input"), bytes);
          const file = { path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
          const token = `route-${String(value)}-${randomUUID().slice(0, 12)}`;
          const photo = await uploadFencedProductPhoto(db, { productId: w2Product, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file });
          expect(photo.productId).toBe(w2Product);
          expect((await ops([token])).map((r) => [r.kind, r.state])).toEqual([["product_upload", "committed"]]);
        } finally { await rm(workDir, { recursive: true, force: true }); }
      }
    } finally {
      if (before === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = before;
      if (beforeSupabaseUrl === undefined) delete process.env.SUPABASE_DATABASE_URL; else process.env.SUPABASE_DATABASE_URL = beforeSupabaseUrl;
    }
  });

  it.skipIf(!enabled)("W2 and W4 share one authority: both crashes are reported together and both recover", async () => {
    const { productId: w4Product, intakeId, stagedIds } = await appliedIntake(1);
    const w2Product = await product();
    const token = `shared-${driver}-${randomUUID().slice(0, 12)}`;
    const workDir = await mkdtemp(path.join(os.tmpdir(), "noctella-w2w4-"));
    const bytes = await jpeg(10, 220);
    await writeFile(path.join(workDir, "input"), bytes);
    const file = () => ({ path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal });
    const w2 = async (hooks?: any) => uploadFencedProductPhoto(db, { productId: w2Product, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file(), 10 * 1024 * 1024), altText: "", file: file() }, { driver, hooks });
    try {
      await expect(w2({ afterPublish: () => { throw new Error("w2 crash"); } })).rejects.toThrow("w2 crash");
      await expect(finalize(intakeId, { hooks: { afterPublish: () => { throw new Error("w4 crash"); } } })).rejects.toThrow("w4 crash");
      await expireAll();
      const report = await listPhotoOperationsRequiringRecovery(db, driver);
      expect(report.filter((r: any) => r.token === token || stagedIds.includes(r.token)).map((r: any) => r.kind).sort()).toEqual(["ai_finalize", "product_upload"]);
      expect((await w2()).productId).toBe(w2Product);
      expect((await finalize(intakeId)).created).toBe(true);
      expect(await counts(w2Product)).toEqual([1, 1]);
      expect(await counts(w4Product)).toEqual([1, 1]);
      const report2 = await listPhotoOperationsRequiringRecovery(db, driver);
      expect(report2.filter((r: any) => r.token === token || stagedIds.includes(r.token))).toEqual([]);
    } finally { await rm(workDir, { recursive: true, force: true }); }
  });
  for(const phase of ["intent","main","thumb","commit"] as const) it.skipIf(!enabled)("SIMULATED remount W4 recovery at "+phase,async()=>{
    const simulation=simulatedPersistentRemount();
    try{const {productId,intakeId,stagedIds}=await appliedIntake(1);const stop=()=>{simulation.replaceInstance();throw Error("simulated instance replacement");};
      if (phase === "commit") { expect((await finalize(intakeId)).created).toBe(true); simulation.replaceInstance(); }
      else await expect(finalize(intakeId,{hooks:phase==="intent"?{afterIntent:stop}:{copyPhase:(_id,artifact,p)=>{if(artifact===phase&&p==="linked")stop();}}})).rejects.toThrow("simulated instance replacement");
      const [oldRow]=await ops(stagedIds);const keys=[oldRow.main_key,oldRow.thumb_key];const before=publicationSnapshot(root,oldRow.id,keys);
      expect((await finalize(intakeId)).created).toBe(phase!=="commit");expect((await finalize(intakeId)).created).toBe(false);expect(await counts(productId)).toEqual([1,1]);
      const rows=await ops(stagedIds);expect(rows[0].state).toBe("committed");expect(Number(rows[0].generation)).toBe(1);
      const [seal]=await q(sql`SELECT main_dev FROM photo_operation_artifacts WHERE operation_id = ${rows[0].id}`);expect(seal.main_dev).toMatch(/^pfs1:/);
      const [intent]=await q(sql`SELECT executor_epoch FROM photo_publication_intents WHERE operation_id = ${rows[0].id}`);expect(Number(intent.executor_epoch)).toBe(phase==="commit"?1:2);
      recordRemountEvidence("W4-"+driver+"-"+phase,{before,after:publicationSnapshot(root,rows[0].id,keys),operation:rows[0],intent,seal,copies:await q(sql`SELECT * FROM photo_publication_copies WHERE operation_id = ${rows[0].id}`),photos:await q(sql`SELECT id,storage_key,thumbnail_storage_key FROM product_photos WHERE id = ${stagedIds[0]}`),outbox:await q(sql`SELECT id,event_type,aggregate_id FROM outbox_events WHERE aggregate_id = ${stagedIds[0]}`)});
    }finally{simulation.restore();}
  });

});
