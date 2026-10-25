/**
 * P5 (#472 parity 4B, option B): protected-mode Instagram derivative store hardening. SQLite (+ PostgreSQL where
 * configured); rendering is confined on Linux CI when F2_CAPABILITY_LAUNCHER is set, in-process (unprotected) elsewhere.
 * Covers store/job-root assertions, no-clobber publication with hash adoption or conflict, fsync ordering and crash
 * points, concurrency, the registered hash-verified route, legacy rows, error classification, untouched protected roots
 * and rollback compatibility of the additive output_sha256 column.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

const { root, launcher } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-ig-p5-"));
  const launcher = process.platform === "linux" ? process.env.F2_CAPABILITY_LAUNCHER : undefined;
  Object.assign(process.env, {
    NODE_ENV: "test", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    INSTAGRAM_MEDIA_ALLOWED_HOSTS: "media.example.test",
    ...(launcher ? { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: launcher } : {}),
  });
  return { root, launcher };
});
vi.setConfig({ testTimeout: 120_000 });

import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { InstagramClientError } from "../src/integrations/instagram/types";
import { PhotoUploadError } from "../src/services/photoUploadAdmission";
import { classifyProtectedFailure, inspectPreparedInstagramImage, prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";
import {
  assertInstagramStoreSafe, InstagramStoreError, instagramDerivativeJobRoot, instagramDerivativeRoot, publishToInstagramStore, sha256, type StorePhase,
} from "../src/integrations/instagram/instagramDerivativeStore";
import { createSocialContentPreparationService } from "../src/services/socialContentPreparation";
import { createInstagramDerivativeAssetRouter } from "../src/routes/instagramDerivativeAssets";
import { photoOperationPrivateRoot } from "../src/services/photoOperationAuthority";
import { photoPublicationStagingRoot } from "../src/services/photoPublicationExecutor";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const canonical = path.join(root, "photos");
const store = () => instagramDerivativeRoot(canonical);
const jobs = () => instagramDerivativeJobRoot(canonical);
const origin = "https://media.example.test";
const fingerprint = (name: string, bytes: Buffer) => createHash("sha256").update(name).update("\0").update(bytes).digest("hex");
const dirLink = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
const unsafe = { name: "InstagramClientError", kind: "processing", retryable: false, code: "INSTAGRAM_STORE_UNSAFE" };

/** name + inode + size + sha256 of every file under a protected root (recursive). */
function inventory(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => { const f = path.join(e.parentPath ?? (e as any).path, e.name), st = fs.statSync(f, { bigint: true });
      return `${path.relative(dir, f)}:${st.ino}:${st.size}:${createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`; }).sort();
}
const protectedRoots = () => [canonical, photoOperationPrivateRoot(canonical), photoPublicationStagingRoot(canonical)];
let protectedBefore: string[][];

const written = new Map<string, Buffer>();
async function photo(name: string, background: string) {
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background } }).webp().toBuffer();
  fs.writeFileSync(path.join(canonical, name), bytes);
  written.set(name, bytes);
  return { url: `/images/product-photos/${name}`, bytes, derivative: `instagram-v1-${fingerprint(name, bytes)}.jpg` };
}

beforeAll(() => {
  for (const dir of protectedRoots()) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(photoOperationPrivateRoot(canonical), "sentinel"), "private evidence");
  fs.writeFileSync(path.join(photoPublicationStagingRoot(canonical), "sentinel"), "publication evidence");
  protectedBefore = protectedRoots().map(inventory);
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required: P5 protected Instagram preparation runs confined", () => {
  expect(launcher).toBeTruthy();
});

describe("store and private job root assertion", () => {
  it("creates both roots as real directories on one filesystem, the job root outside the served store", async () => {
    const roots = await assertInstagramStoreSafe(canonical);
    expect(roots).toEqual({ store: fs.realpathSync(store()), jobs: fs.realpathSync(jobs()) });
    expect(path.relative(roots.store, roots.jobs).startsWith("..")).toBe(true);
    if (process.platform !== "win32") for (const dir of [roots.store, roots.jobs]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["equals the store", (s: string) => s],
    ["is an ancestor of the store", (s: string) => path.dirname(s)],
    ["is a descendant of the store", (s: string) => path.join(s, "nested")],
    ["equals the job root", (_s: string, j: string) => j],
    ["is a descendant of the job root", (_s: string, j: string) => path.join(j, "nested")],
  ])("refuses when a protected root (AI intake) %s, before any write", async (_label, pick) => {
    const base = fs.mkdtempSync(path.join(root, "overlap-")), photos = path.join(base, "photos");
    fs.mkdirSync(photos);
    const env = { ...process.env, AI_INTAKE_PHOTO_DIR: pick(instagramDerivativeRoot(photos), instagramDerivativeJobRoot(photos)) };
    const before = fs.readdirSync(base).sort();
    await expect(assertInstagramStoreSafe(photos, env)).rejects.toMatchObject(unsafe);
    expect(fs.readdirSync(base).sort()).toEqual(before); // refused before creating either root
  });

  it("refuses when the canonical root itself would be the store", async () => {
    const base = fs.mkdtempSync(path.join(root, "same-")), photos = path.join(base, "instagram-derivatives");
    fs.mkdirSync(photos);
    await expect(assertInstagramStoreSafe(photos)).rejects.toMatchObject(unsafe);
  });

  it.each(["store", "job root"])("refuses a symlinked %s and writes nothing through it", async (which) => {
    const base = fs.mkdtempSync(path.join(root, "link-")), photos = path.join(base, "photos"), target = path.join(base, "target");
    fs.mkdirSync(photos); fs.mkdirSync(target);
    dirLink(target, which === "store" ? instagramDerivativeRoot(photos) : instagramDerivativeJobRoot(photos));
    await expect(assertInstagramStoreSafe(photos)).rejects.toMatchObject(unsafe);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("refuses a realpath overlap that lexical paths hide (symlinked parent)", async () => {
    const base = fs.mkdtempSync(path.join(root, "real-")), real = path.join(base, "real"), alias = path.join(base, "alias");
    fs.mkdirSync(path.join(real, "photos"), { recursive: true });
    dirLink(real, alias);
    const env = { ...process.env, AI_INTAKE_PHOTO_DIR: path.join(real, "instagram-derivatives") }; // lexically different
    await expect(assertInstagramStoreSafe(path.join(alias, "photos"), env)).rejects.toMatchObject(unsafe);
  });

  it("preparation refuses (not retryable) when the store is unsafe, writing nothing", async () => {
    const base = fs.mkdtempSync(path.join(root, "prep-unsafe-")), photos = path.join(base, "photos"), target = path.join(base, "target");
    fs.mkdirSync(photos); fs.mkdirSync(target);
    const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } }).webp().toBuffer();
    fs.writeFileSync(path.join(photos, "x.webp"), source);
    dirLink(target, instagramDerivativeRoot(photos));
    await expect(prepareInstagramImageAsset({ url: "/images/product-photos/x.webp" }, origin, process.env, photos)).rejects.toMatchObject(unsafe);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

describe("publication: no-clobber link, hash adoption or conflict, fsync ordering and crash points", () => {
  const bytes = (seed: string) => Buffer.from(`synthetic-derivative-${seed}`);
  const name = (seed: string) => `instagram-v1-${createHash("sha256").update(seed).digest("hex")}.jpg`;
  const tmpLeft = () => fs.readdirSync(jobs()).filter((f) => f.endsWith(".tmp"));

  it("orders tmp fsync -> link -> directory fsync -> verify, leaving no temporary", async () => {
    const roots = await assertInstagramStoreSafe(canonical), phases: StorePhase[] = [];
    const digest = await publishToInstagramStore(bytes("order"), name("order"), roots, (p) => { phases.push(p); });
    expect(phases).toEqual(["tmp-fsynced", "linked", "dir-fsynced", "verified"]);
    expect(digest).toBe(sha256(bytes("order")));
    expect(tmpLeft()).toEqual([]);
  });

  it.each<[StorePhase, boolean]>([["tmp-fsynced", false], ["linked", true], ["dir-fsynced", true], ["verified", true]])(
    "crash at %s: never a partial store file; the retry adopts equal bytes and refuses different bytes", async (phase, linked) => {
      const roots = await assertInstagramStoreSafe(canonical), seed = `crash-${phase}`, file = path.join(roots.store, name(seed));
      await expect(publishToInstagramStore(bytes(seed), name(seed), roots, (p) => { if (p === phase) throw new Error("crash"); })).rejects.toThrow("crash");
      expect(fs.existsSync(file)).toBe(linked);
      if (linked) expect(fs.readFileSync(file)).toEqual(bytes(seed)); // complete, fsynced bytes only (never a partial file)
      const phases: StorePhase[] = [];
      expect(await publishToInstagramStore(bytes(seed), name(seed), roots, (p) => { phases.push(p); })).toBe(sha256(bytes(seed)));
      expect(phases[1]).toBe(linked ? "adopted" : "linked");
      await expect(publishToInstagramStore(bytes(`${seed}-other`), name(seed), roots)).rejects.toMatchObject({ code: "INSTAGRAM_STORE_KEY_CONFLICT", retryable: false });
      expect(fs.readFileSync(file)).toEqual(bytes(seed));
      expect(tmpLeft()).toEqual([]);
    });

  it("same name with different bytes during preparation: INSTAGRAM_STORE_KEY_CONFLICT; the existing file is unchanged (hash + inode)", async () => {
    const p = await photo("conflict.webp", "#aa3300");
    await assertInstagramStoreSafe(canonical);
    const foreign = path.join(store(), p.derivative);
    fs.writeFileSync(foreign, "foreign bytes at the content-addressed key");
    const before = fs.statSync(foreign, { bigint: true }), hash = sha256(fs.readFileSync(foreign));
    await expect(prepareInstagramImageAsset({ url: p.url }, origin, process.env, canonical)).rejects.toMatchObject({ code: "INSTAGRAM_STORE_KEY_CONFLICT", kind: "processing", retryable: false });
    const after = fs.statSync(foreign, { bigint: true });
    expect([after.ino, sha256(fs.readFileSync(foreign))]).toEqual([before.ino, hash]);
  });

  it("the recipe is deterministic: identical input publishes identical bytes (adopted on repeat)", async () => {
    const p = await photo("determinism.webp", "#336699");
    const first = await prepareInstagramImageAsset({ url: p.url }, origin, process.env, canonical);
    const second = await prepareInstagramImageAsset({ url: p.url }, origin, process.env, canonical);
    expect(second.outputSha256).toBe(first.outputSha256);
    expect(sha256(fs.readFileSync(path.join(store(), p.derivative)))).toBe(first.outputSha256);
  });
});

describe("social preparation, registered route and legacy rows", () => {
  let db: ReturnType<typeof createTestDb>, app: express.Express;
  const render: typeof prepareInstagramImageAsset = (photoRef, publicOrigin, _env, _root, recipe) => prepareInstagramImageAsset(photoRef, publicOrigin, process.env, canonical, recipe);
  const service = () => createSocialContentPreparationService(db, "test-memory", render);
  const rows = () => db.select().from(schema.socialPreparedImages);
  let p: Awaited<ReturnType<typeof photo>>;
  beforeAll(async () => {
    db = createTestDb();
    p = await photo("social.webp", "#118844");
    await db.insert(schema.products).values({ id: "p", sku: "p", title: "p", slug: "p", type: "unique_item", status: "draft" });
    await db.insert(schema.productPhotos).values({ id: "photo", productId: "p", processingStatus: "Ready", url: p.url, thumbnailUrl: "/images/product-photos/t.webp",
      filename: "social.webp", storageKey: "social.webp", mimeType: "image/webp", sizeBytes: p.bytes.length, width: 320, height: 200 });
    await db.insert(schema.socialContents).values({ id: "content", productId: "p", contentType: "post", caption: "c" });
    await db.insert(schema.socialContentMedia).values({ id: "selection", contentId: "content", photoId: "photo", sortOrder: 0 });
    app = express().use(createInstagramDerivativeAssetRouter(db as any, store));
  });

  it("N concurrent preparations: one store file, one row, identical recorded hash", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => service().prepare("content", "photo", origin)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.outputSha256)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(results[0].outputSha256).toBe(sha256(fs.readFileSync(path.join(store(), p.derivative))));
    expect(fs.readdirSync(store()).filter((f) => f === p.derivative)).toHaveLength(1);
  });

  it("route: registered + matching hash -> 200 image/jpeg with exactly the stored bytes", async () => {
    const [row] = await rows();
    const res = await request(app).get(row.outputPath).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(Buffer.compare(res.body, fs.readFileSync(path.join(store(), p.derivative)))).toBe(0);
  });

  it("route: unregistered, NULL hash, traversal, foreign names, temporaries and nested paths -> 404", async () => {
    const other = await photo("unregistered.webp", "#552288");
    await prepareInstagramImageAsset({ url: other.url }, origin, process.env, canonical); // file exists, no row
    expect((await request(app).get(`/images/instagram-derivatives/${other.derivative}`)).status).toBe(404);
    const nullHash = await photo("nullhash.webp", "#225588");
    await prepareInstagramImageAsset({ url: nullHash.url }, origin, process.env, canonical);
    await db.insert(schema.socialPreparedImages).values({ id: "null-hash", contentId: "content", sourcePhotoId: "other", sourceFingerprint: "f".repeat(64),
      recipeVersion: "instagram-v1", outputPath: `/images/instagram-derivatives/${nullHash.derivative}`, outputSha256: null });
    expect((await request(app).get(`/images/instagram-derivatives/${nullHash.derivative}`)).status).toBe(404);
    fs.writeFileSync(path.join(jobs(), ".instagram-x.tmp"), "tmp");
    for (const bad of ["..%2fphotos%2fsocial.webp", "..%2F..%2Fphotos%2Fsocial.webp", ".instagram-x.tmp", "social.webp", "instagram-v1-zz.jpg",
      `instagram-v2-${"a".repeat(64)}.jpg`, `${p.derivative}%00.png`, `nested/${p.derivative}`, ".job-x/source.webp", ""]) {
      expect((await request(app).get(`/images/instagram-derivatives/${bad}`)).status, bad).toBe(404);
    }
  });

  it.skipIf(process.platform === "win32")("route: a registered name that is a symlink in the store -> 404", async () => {
    const [row] = await rows(), file = path.join(store(), path.basename(row.outputPath)), moved = path.join(root, "moved.jpg");
    fs.renameSync(file, moved); fs.symlinkSync(moved, file);
    try { expect((await request(app).get(row.outputPath)).status).toBe(404); }
    finally { fs.unlinkSync(file); fs.renameSync(moved, file); }
  });

  it("route and inspection: a tampered stored file -> 404 and not current", async () => {
    const [row] = await rows(), file = path.join(store(), path.basename(row.outputPath)), original = fs.readFileSync(file);
    fs.chmodSync(file, 0o600); fs.appendFileSync(file, "tamper");
    try {
      expect((await request(app).get(row.outputPath)).status).toBe(404);
      expect(await inspectPreparedInstagramImage({ url: p.url }, row, canonical)).toBe(false);
    } finally { fs.writeFileSync(file, original); }
    expect(await inspectPreparedInstagramImage({ url: p.url }, row, canonical)).toBe(true);
  });

  async function selectPhoto(id: string, name: string, background: string, sortOrder: number) {
    const added = await photo(name, background);
    await db.insert(schema.productPhotos).values({ id, productId: "p", processingStatus: "Ready", url: added.url, thumbnailUrl: `/images/product-photos/${id}-t.webp`,
      filename: name, storageKey: name, mimeType: "image/webp", sizeBytes: added.bytes.length, width: 320, height: 200 });
    await db.insert(schema.socialContentMedia).values({ id: `selection-${id}`, contentId: "content", photoId: id, sortOrder });
    return added;
  }
  const routeGet = (outputPath: string) => request(app).get(outputPath).buffer(true)
    .parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });

  it("crash after link, before DB persist: nothing registered so the route serves nothing; the retry adopts equal bytes, persists one row, then serves it", async () => {
    const added = await selectPhoto("crash-before-persist", "crash-before-persist.webp", "#6a1b9a", 10);
    let crashed = false;
    const crashing: typeof prepareInstagramImageAsset = async (...args) => {
      const asset = await render(...args); // published (linked, dir-fsynced, verified) into the store
      if (!crashed) { crashed = true; throw new Error("crash after publication, before DB persist"); }
      return asset;
    };
    const svc = () => createSocialContentPreparationService(db, "test-memory", crashing);
    await expect(svc().prepare("content", "crash-before-persist", origin)).rejects.toThrow();
    const file = path.join(store(), added.derivative), linked = fs.statSync(file, { bigint: true }), bytes = fs.readFileSync(file);
    expect(await db.select().from(schema.socialPreparedImages).where(eq(schema.socialPreparedImages.sourcePhotoId, "crash-before-persist"))).toEqual([]);
    expect((await routeGet(`/images/instagram-derivatives/${added.derivative}`)).status).toBe(404);
    const retried = await svc().prepare("content", "crash-before-persist", origin);
    expect(retried.outputSha256).toBe(sha256(bytes));
    expect(fs.statSync(file, { bigint: true }).ino).toBe(linked.ino); // adopted, not replaced
    expect(await db.select().from(schema.socialPreparedImages).where(eq(schema.socialPreparedImages.sourcePhotoId, "crash-before-persist"))).toHaveLength(1);
    const served = await routeGet(retried.outputPath);
    expect([served.status, Buffer.compare(served.body, bytes)]).toEqual([200, 0]);
  });

  it("crash after DB persist: the retry returns the same row and adopts; different bytes at the key are refused and never served", async () => {
    const added = await selectPhoto("crash-after-persist", "crash-after-persist.webp", "#00695c", 11);
    const first = await service().prepare("content", "crash-after-persist", origin); // persisted; the caller then "crashes"
    const again = await service().prepare("content", "crash-after-persist", origin);
    expect([again.id, again.outputSha256, again.outputPath]).toEqual([first.id, first.outputSha256, first.outputPath]);
    expect(await db.select().from(schema.socialPreparedImages).where(eq(schema.socialPreparedImages.sourcePhotoId, "crash-after-persist"))).toHaveLength(1);
    const file = path.join(store(), added.derivative), original = fs.readFileSync(file);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, "different bytes at the content-addressed key");
    const changed = fs.statSync(file, { bigint: true });
    try {
      await expect(service().prepare("content", "crash-after-persist", origin)).rejects.toThrow();
      await expect(prepareInstagramImageAsset({ url: added.url }, origin, process.env, canonical)).rejects.toMatchObject({ code: "INSTAGRAM_STORE_KEY_CONFLICT", retryable: false });
      expect(fs.statSync(file, { bigint: true }).ino).toBe(changed.ino); // refused: never overwritten or deleted
      expect((await routeGet(first.outputPath)).status).toBe(404); // hash mismatch: nothing partial or foreign is served
      expect(await db.select().from(schema.socialPreparedImages).where(eq(schema.socialPreparedImages.id, first.id))).toEqual([expect.objectContaining({ outputSha256: first.outputSha256 })]);
    } finally { fs.writeFileSync(file, original); }
    expect((await routeGet(first.outputPath)).status).toBe(200);
  });

  it("legacy NULL-hash row (owner decision): not current, re-preparation refuses and never modifies it", async () => {
    const legacy = await photo("legacy.webp", "#884411");
    await db.insert(schema.productPhotos).values({ id: "legacy-photo", productId: "p", processingStatus: "Ready", url: legacy.url, thumbnailUrl: "/images/product-photos/t2.webp",
      filename: "legacy.webp", storageKey: "legacy.webp", mimeType: "image/webp", sizeBytes: legacy.bytes.length, width: 320, height: 200 });
    await db.insert(schema.socialContentMedia).values({ id: "selection-legacy", contentId: "content", photoId: "legacy-photo", sortOrder: 1 });
    const legacyRow = { id: "legacy-row", contentId: "content", sourcePhotoId: "legacy-photo", sourceFingerprint: fingerprint("legacy.webp", legacy.bytes),
      recipeVersion: "instagram-v1", outputPath: `/images/product-photos/${legacy.derivative}`, outputSha256: null };
    await db.insert(schema.socialPreparedImages).values(legacyRow);
    await expect(service().validatePreparedImageCurrent("content", "legacy-row")).rejects.toThrow("Prepared image is not current");
    await expect(service().prepare("content", "legacy-photo", origin)).rejects.toThrow("not current for protected mode");
    expect(await db.select().from(schema.socialPreparedImages).where(eq(schema.socialPreparedImages.id, "legacy-row"))).toEqual([legacyRow]);
  });
});

describe("protected-mode error classification (existing kinds; blocking storage is not retryable)", () => {
  it.each(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "EIO"])("%s (parent or worker-reported) -> INSTAGRAM_STORE_BLOCKED, not retryable, path-free log", (code) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const error of [Object.assign(new Error(`write /var/data/x ${code}`), { code }), new PhotoUploadError(500, code, `/secret/path ${code}`)]) {
        const classified = classifyProtectedFailure(error);
        expect(classified).toBeInstanceOf(InstagramStoreError);
        expect(classified).toMatchObject({ kind: "processing", retryable: false, code: "INSTAGRAM_STORE_BLOCKED" });
        expect(classified.message).not.toMatch(/var\/data|secret/);
      }
      expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
        { event: "instagram_derivative_store_refused", code: "INSTAGRAM_STORE_BLOCKED", errno: code },
        { event: "instagram_derivative_store_refused", code: "INSTAGRAM_STORE_BLOCKED", errno: code },
      ]);
    } finally { warn.mockRestore(); }
  });
  it("confined-worker start failure, timeout or missing enforcement (503) -> processing, retryable", () => {
    for (const code of ["PHOTO_PREPARATION_UNAVAILABLE", "PHOTO_PUBLICATION_NOT_READY"])
      expect(classifyProtectedFailure(new PhotoUploadError(503, code, "x"))).toMatchObject({ kind: "processing", retryable: true });
  });
  it("store unsafe / key conflict pass through unchanged (not retryable)", () => {
    for (const code of ["INSTAGRAM_STORE_UNSAFE", "INSTAGRAM_STORE_KEY_CONFLICT"] as const) {
      const error = new InstagramStoreError(code);
      expect(classifyProtectedFailure(error)).toBe(error);
    }
  });
  it("media/format and unknown failures -> invalid_media, not retryable", () => {
    for (const error of [new InstagramClientError("invalid_media", false), new PhotoUploadError(500, "PHOTO_PREPARATION_FAILED", "bad"), new Error("sharp: corrupt"), "x"])
      expect(classifyProtectedFailure(error)).toMatchObject({ kind: "invalid_media", retryable: false });
  });
});

describe("rollback compatibility of the additive output_sha256 column", () => {
  it("0045 is additive and nullable only", () => {
    const text = fs.readFileSync(path.join(__dirname, "../src/db/postgres-migrations/0045_social_prepared_image_output_sha256.sql"), "utf8");
    const statements = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(statements).toEqual(["ALTER TABLE social_prepared_images ADD COLUMN IF NOT EXISTS output_sha256 TEXT;"]);
  });
  it("SQLite: an existing pre-P5 table gains the column without changing rows; old-style writes and current reads work", () => {
    const raw = new Database(":memory:");
    ensureSchema(raw);
    // A pre-P5 database: the current schema without output_sha256, holding a legacy row.
    raw.exec("ALTER TABLE social_prepared_images DROP COLUMN output_sha256");
    raw.exec("INSERT INTO social_contents (id, content_type) VALUES ('c', 'post')");
    raw.exec("INSERT INTO social_prepared_images VALUES ('old', 'c', 'ph', 'fp', 'instagram-v1', '/images/product-photos/instagram-v1-x.jpg')");
    ensureSchema(raw);
    const columns = (raw.prepare("PRAGMA table_info(social_prepared_images)").all() as Array<{ name: string; notnull: number }>);
    expect(columns.find((c) => c.name === "output_sha256")).toMatchObject({ notnull: 0 });
    raw.exec("INSERT INTO social_prepared_images (id, content_id, source_photo_id, source_fingerprint, recipe_version, output_path) VALUES ('old2', 'c', 'ph2', 'fp', 'instagram-v1', '/p')"); // pre-P5 code path
    const db = drizzle(raw, { schema });
    expect(db.select().from(schema.socialPreparedImages).all().map((r) => [r.id, r.outputSha256])).toEqual([["old", null], ["old2", null]]);
    ensureSchema(raw); // idempotent
    raw.close();
  });
  it.runIf(postgresTestConfigured)("PostgreSQL: 0045 applies after 0044, preserves rows, is idempotent; pre-P5 writes still work", async () => {
    const h = await createPostgresTestDb("0044_photo_publication_copies.sql");
    try {
      await h.pool.query("INSERT INTO social_contents (id, content_type) VALUES ('c', 'post')");
      await h.pool.query("INSERT INTO social_prepared_images (id, content_id, source_photo_id, source_fingerprint, recipe_version, output_path) VALUES ('old', 'c', 'ph', 'fp', 'instagram-v1', '/p')");
      const migration = fs.readFileSync(path.join(__dirname, "../src/db/postgres-migrations/0045_social_prepared_image_output_sha256.sql"), "utf8");
      await h.pool.query(migration); await h.pool.query(migration);
      await h.pool.query("INSERT INTO social_prepared_images (id, content_id, source_photo_id, source_fingerprint, recipe_version, output_path) VALUES ('old2', 'c', 'ph2', 'fp', 'instagram-v1', '/p2')");
      const { rows } = await h.pool.query("SELECT id, output_sha256 FROM social_prepared_images ORDER BY id");
      expect(rows).toEqual([{ id: "old", output_sha256: null }, { id: "old2", output_sha256: null }]);
      const column = (await h.pool.query("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'social_prepared_images' AND column_name = 'output_sha256' AND table_schema = $1", [h.schemaName])).rows[0];
      expect(column).toEqual({ is_nullable: "YES", data_type: "text" });
      // Existing read paths with the column present: the shared PostgreSQL drizzle schema and the prepared-image repository
      // find() used by inspection, approvals and publishing validation.
      const pgSchema = await import("../src/db/schema.postgres");
      expect((await h.db.select().from(pgSchema.socialPreparedImages)).map((r) => [r.id, r.outputPath, r.outputSha256]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([["old", "/p", null], ["old2", "/p2", null]]);
      const { createPreparedImageRepository } = await import("../src/repositories/social-content/preparedImages");
      const repo = createPreparedImageRepository(h.db as any, "postgres");
      expect(await repo.transaction(function* (tx: any) { return yield* repo.find(tx, "c", "old"); })).toMatchObject({ id: "old", outputPath: "/p", outputSha256: null });
    } finally { await h.close(); }
  });
});

it("protected roots are unchanged: private-operation and publication identical; canonical holds exactly this suite's synthetic sources", () => {
  const [canon, priv, pub] = protectedRoots().map(inventory);
  expect([priv, pub]).toEqual([protectedBefore[1], protectedBefore[2]]);
  // Name + inode + size + sha256: each source is byte-identical to what was written; no derivative or temporary appeared.
  expect(canon.map((entry) => entry.split(":")[0])).toEqual([...written.keys()].sort());
  for (const entry of canon) { const [file, , size, hash] = entry.split(":"); expect([Number(size), hash]).toEqual([written.get(file)!.length, sha256(written.get(file)!)]); }
});
