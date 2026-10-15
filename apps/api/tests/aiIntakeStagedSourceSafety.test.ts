/**
 * #390 Stage 1: safe staged-source foundation (no original-source writer exists yet).
 * Covers key generations, mixed-generation cleanup recognition, exposure-safe reads (Admin content route and AI
 * providers), the private W4 source reader, metadata (EXIF/GPS/serial) non-disclosure, malformed content,
 * symlink/traversal resistance and byte-identical legacy behaviour. Synthetic images only.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRole } from "@noctella/shared";
import { createTestDb } from "./testDb";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { aiIntakePhotos } from "../src/db/schema";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import { isOriginalSourceStagedKey, isStagedPartialFilename, parseStagedKey } from "../src/services/aiIntakeStagedKey";
import { readStagedPhotoForExposure, STAGED_PREVIEW_MAX_SIDE } from "../src/services/aiIntakeStagedExposure";
import { LocalAiIntakePhotoReader, LocalAiIntakePhotoPreviewReader } from "../src/ai-intake/photoReader";
import { LocalAiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { isPrivateStagedFilename, runAiIntakeCleanupUseCase, type AiIntakeCleanupInput, type AiIntakeCleanupUseCaseDeps } from "../src/use-cases/ai-intake-cleanup/useCases";
import { createDrizzleAiIntakeCleanupRepository } from "../src/repositories/ai-intake-cleanup/drizzle";
import { deleteManagedFile, walkManagedDirectory } from "../src/services/managedFileDeletion";

// Runs before the (hoisted) imports, so modules that read the staging root at load time see the disposable directory.
const { routeStagingRoot } = vi.hoisted(() => {
  const { mkdtempSync: mkdtemp } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtemp(join(tmpdir(), "noctella-staged-source-route-"));
  Object.assign(process.env, {
    DATABASE_URL: ":memory:",
    MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    MARKETPLACE_OAUTH_STATE_SECRET: "state-secret-for-ai-intake-staged-source-safety",
    ADMIN_APP_ORIGIN: "http://localhost:3001",
    STOREFRONT_APP_ORIGIN: "http://localhost:3000",
    AI_INTAKE_PHOTO_DIR: root,
  });
  return { routeStagingRoot: root };
});

/** Creates a symlink, or returns false where the platform does not allow it (same policy as the existing content tests). */
async function trySymlink(target: string, link: string): Promise<boolean> {
  try { await symlink(target, link); return true; }
  catch (err: any) { if (err?.code === "EPERM" || err?.code === "EACCES") return false; throw err; }
}

const MARKERS = ["SERIAL-390-TEST", "GPS-390-DATUM", "SyntheticCam"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const markersIn = (bytes: Buffer) => MARKERS.filter((m) => bytes.includes(Buffer.from(m, "latin1")));

/** Minimal little-endian EXIF: IFD0 (Make, Orientation), Exif IFD (BodySerialNumber), GPS IFD (position + MapDatum marker). */
function exifTiff(orientation: number): Buffer {
  const ascii = (s: string) => Buffer.from(s + "\0", "latin1");
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const rationals = (values: number[]) => Buffer.concat(values.flatMap((v) => [u32(v), u32(1)]));
  type Entry = { tag: number; type: number; count: number; value: Buffer };
  const e = (tag: number, type: number, count: number, value: Buffer): Entry => ({ tag, type, count, value });
  const size = (entries: Entry[]) => 2 + entries.length * 12 + 4 + entries.reduce((n, x) => n + (x.value.length > 4 ? x.value.length + (x.value.length % 2) : 0), 0);
  const gps = [e(0, 1, 4, Buffer.from([2, 3, 0, 0])), e(1, 2, 2, ascii("N")), e(2, 5, 3, rationals([52, 31, 12])), e(3, 2, 2, ascii("E")), e(4, 5, 3, rationals([13, 24, 36])), e(0x12, 2, 14, ascii("GPS-390-DATUM"))];
  const exif = [e(0xa431, 2, 16, ascii("SERIAL-390-TEST"))];
  const ifd0 = [e(0x010f, 2, 13, ascii("SyntheticCam")), e(0x0112, 3, 1, u16(orientation)), e(0x8769, 4, 1, u32(0)), e(0x8825, 4, 1, u32(0))];
  const exifAt = 8 + size(ifd0), gpsAt = exifAt + size(exif);
  ifd0[2].value = u32(exifAt); ifd0[3].value = u32(gpsAt);
  const out = Buffer.alloc(gpsAt + size(gps));
  out.write("II", 0, "latin1"); out.writeUInt16LE(42, 2); out.writeUInt32LE(8, 4);
  const write = (entries: Entry[], at: number) => {
    out.writeUInt16LE(entries.length, at);
    let data = at + 2 + entries.length * 12 + 4;
    entries.forEach((x, i) => {
      const p = at + 2 + i * 12;
      out.writeUInt16LE(x.tag, p); out.writeUInt16LE(x.type, p + 2); out.writeUInt32LE(x.count, p + 4);
      if (x.value.length <= 4) x.value.copy(out, p + 8);
      else { out.writeUInt32LE(data, p + 8); x.value.copy(out, data); data += x.value.length + (x.value.length % 2); }
    });
  };
  write(ifd0, 8); write(exif, exifAt); write(gps, gpsAt);
  return out;
}

/** 3000x1200 JPEG carrying orientation 6, GPS, camera make/serial and a Display P3 profile. */
async function metadataRichJpeg(): Promise<Buffer> {
  const jpeg = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: { r: 200, g: 40, b: 90 } } }).withIccProfile("p3").jpeg({ quality: 90 }).toBuffer();
  const tiff = exifTiff(6);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, Buffer.from("Exif\0\0", "latin1"), tiff, jpeg.subarray(2)]);
}

describe("staged key generations", () => {
  const id = randomUUID();
  it("parses legacy and original-source keys and nothing else", () => {
    expect(parseStagedKey(`${id}.webp`)).toEqual({ generation: "legacy-webp", format: "webp" });
    expect(parseStagedKey(`${id}.orig.jpg`)).toEqual({ generation: "original", format: "jpeg" });
    expect(parseStagedKey(`${id}.orig.png`)).toEqual({ generation: "original", format: "png" });
    expect(parseStagedKey(`${id}.orig.webp`)).toEqual({ generation: "original", format: "webp" });
    for (const bad of [`${id.toUpperCase()}.orig.jpg`, `${id}.orig.gif`, `${id}.orig.jpeg`, `${id}.orig.jpg.webp`, `x/${id}.orig.jpg`, `../${id}.orig.jpg`, `${id}.ORIG.jpg`, "mock-key-1.webp", `.${id}.partial`]) {
      expect(parseStagedKey(bad)).toBeNull();
    }
    expect(isOriginalSourceStagedKey(`${id}.webp`)).toBe(false);
    expect(isStagedPartialFilename(`.${id}.partial`)).toBe(true);
    expect(isStagedPartialFilename(`${id}.partial`)).toBe(false);
  });

  it("cleanup recognises both generations and unpublished partials, still nothing else", () => {
    expect(isPrivateStagedFilename(`${id}.webp`)).toBe(true);
    expect(isPrivateStagedFilename(`${id}.orig.jpg`)).toBe(true);
    expect(isPrivateStagedFilename(`.${id}.partial`)).toBe(true);
    for (const bad of [`${id}.orig.gif`, `${id}.orig.jpg.tmp`, `.${id}.partial.x`, `${id}-thumb.webp`, "not-a-uuid.orig.jpg"]) expect(isPrivateStagedFilename(bad)).toBe(false);
  });
});

describe("mixed-generation orphan sweep (real filesystem, real use case)", () => {
  let db: ReturnType<typeof createTestDb>;
  let privateRoot: string;
  let canonicalRoot: string;
  beforeEach(async () => {
    db = createTestDb();
    privateRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-staged-mixed-private-"));
    canonicalRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-staged-mixed-canonical-"));
  });
  afterEach(async () => {
    await rm(privateRoot, { recursive: true, force: true });
    await rm(canonicalRoot, { recursive: true, force: true });
  });
  const deps = (): AiIntakeCleanupUseCaseDeps => ({
    repository: createDrizzleAiIntakeCleanupRepository(db as any, sqliteSchema),
    listStagedPhotosByIntake: async () => [],
    walkPrivateRoot: (o) => walkManagedDirectory(privateRoot, o),
    walkCanonicalRoot: (o) => walkManagedDirectory(canonicalRoot, o),
    deletePrivateFile: (k) => deleteManagedFile(privateRoot, k),
    deleteCanonicalFile: (k) => deleteManagedFile(canonicalRoot, k),
  });
  const input = (now: Date, processStartedAt: Date): AiIntakeCleanupInput => ({
    dryRun: false, batchSize: 100, executionEnabled: true, now, processStartedAt,
    cancelledStagedRetentionMs: 1000, finalizedStagedRetentionMs: 1000, orphanGraceMs: 60_000,
    maxExaminedEntriesPerRoot: 100_000, scanTimeBudgetMsPerRoot: 10_000,
  });

  it("deletes aged unowned files of every generation, keeps owned, young, unknown and symlinked entries", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const legacy = `${randomUUID()}.webp`, original = `${randomUUID()}.orig.jpg`, partial = `.${randomUUID()}.partial`;
    const owned = `${randomUUID()}.orig.png`, young = `${randomUUID()}.orig.webp`, unknown = `${randomUUID()}.orig.gif`, link = `${randomUUID()}.orig.jpg`;
    for (const name of [legacy, original, partial, owned, unknown]) { await writeFile(path.join(privateRoot, name), "x"); await utimes(path.join(privateRoot, name), old, old); }
    await writeFile(path.join(privateRoot, young), "x");
    const linked = await trySymlink(path.join(privateRoot, owned), path.join(privateRoot, link));
    db.insert(aiIntakePhotos).values({ id: randomUUID(), intakeId: randomUUID(), storageKey: owned, originalFilename: "a.png", createdByAdminUserId: "admin" }).run();

    const result = await runAiIntakeCleanupUseCase(deps(), input(new Date(), new Date(Date.now() + 5000)));
    const remaining = (await import("node:fs")).readdirSync(privateRoot).sort();
    expect(remaining).toEqual((linked ? [owned, young, unknown, link] : [owned, young, unknown]).sort());
    expect(result.privateOrphansDeleted).toBe(3);
    expect(result.activeSourceRowsRetained).toBe(1);
    expect(result.ageProtected).toBe(1);
    expect(result.unknownFilesRetained).toBe(1);
    expect(result.symlinksRetained).toBe(linked ? 1 : 0);
  });
});

describe("exposure-safe reads", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "noctella-staged-exposure-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("legacy and non-original keys return the stored bytes unchanged (byte-identical)", async () => {
    const webp = await sharp({ create: { width: 64, height: 32, channels: 3, background: "green" } }).webp().toBuffer();
    for (const key of [`${randomUUID()}.webp`, "mock-key-1.webp", "anything-else.bin"]) {
      await writeFile(path.join(root, key), webp);
      expect(sha(await readStagedPhotoForExposure(path.join(root, key), key))).toBe(sha(webp));
    }
  });

  it("an original-source upload is served only as an oriented, bounded, metadata-free WebP preview", async () => {
    const original = await metadataRichJpeg();
    expect(markersIn(original)).toEqual(MARKERS);
    expect((await sharp(original).metadata()).orientation).toBe(6);
    const key = `${randomUUID()}.orig.jpg`;
    await writeFile(path.join(root, key), original);
    const preview = await readStagedPhotoForExposure(path.join(root, key), key);
    const meta = await sharp(preview).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([819, STAGED_PREVIEW_MAX_SIDE]); // rotated portrait, longest side bounded
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(markersIn(preview)).toEqual([]);
    expect(sha(await readFile(path.join(root, key)))).toBe(sha(original)); // the private original is never modified
  });

  it("small originals are not enlarged; PNG and WebP originals are previewed", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
    const webp = await sharp({ create: { width: 50, height: 20, channels: 3, background: "white" } }).webp().toBuffer();
    for (const [bytes, ext, dims] of [[png, "png", [40, 30]], [webp, "webp", [50, 20]]] as const) {
      const key = `${randomUUID()}.orig.${ext}`;
      await writeFile(path.join(root, key), bytes);
      const meta = await sharp(await readStagedPhotoForExposure(path.join(root, key), key)).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", ...dims]);
    }
  });

  it("content that does not match the key's format, or is not an image, fails closed without leaking the path", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    const cases: Array<[string, Buffer]> = [
      [`${randomUUID()}.orig.jpg`, png],
      [`${randomUUID()}.orig.png`, Buffer.from("not an image at all")],
      [`${randomUUID()}.orig.webp`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
      [`${randomUUID()}.orig.jpg`, (await metadataRichJpeg()).subarray(0, 400)],
    ];
    for (const [key, bytes] of cases) {
      await writeFile(path.join(root, key), bytes);
      const error = await readStagedPhotoForExposure(path.join(root, key), key).then(() => null, (e: Error) => e);
      expect(error?.message).toBe("Staged AI intake photo could not be read");
      expect(String(error?.message)).not.toContain(root);
    }
  });
});

describe("staged photo readers", () => {
  let root: string;
  let original: Buffer;
  const key = `${randomUUID()}.orig.jpg`;
  beforeAll(async () => { original = await metadataRichJpeg(); });
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "noctella-staged-readers-")); await writeFile(path.join(root, key), original); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const resolver = (map: Record<string, string>) => ({ resolve: async (id: string) => map[id] ?? null });

  it("the W4 source reader returns the private original bytes exactly", async () => {
    const reader = new LocalAiIntakePhotoReader(resolver({ p: key }), root);
    expect(sha(await reader.read("p"))).toBe(sha(original));
  });

  it("the AI-provider reader never returns raw original-source bytes; legacy bytes are unchanged", async () => {
    const legacyKey = `${randomUUID()}.webp`;
    const legacy = await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).webp().toBuffer();
    await writeFile(path.join(root, legacyKey), legacy);
    const reader = new LocalAiIntakePhotoPreviewReader(resolver({ p: key, l: legacyKey }), root);
    const preview = await reader.read("p");
    expect(markersIn(preview)).toEqual([]);
    expect((await sharp(preview).metadata()).exif).toBeUndefined();
    expect(sha(await reader.read("l"))).toBe(sha(legacy));
  });

  it("both readers refuse symlinks, directories and traversal, and report a missing file as NotFound", async () => {
    const linked = await trySymlink(path.join(root, key), path.join(root, "link.orig.jpg"));
    await mkdir(path.join(root, "dir.orig.jpg"));
    for (const Reader of [LocalAiIntakePhotoReader, LocalAiIntakePhotoPreviewReader]) {
      const reader = new Reader(resolver({ s: "link.orig.jpg", d: "dir.orig.jpg", t: "../escape.orig.jpg", m: `${randomUUID()}.orig.jpg` }), root);
      if (linked) await expect(reader.read("s")).rejects.toBeInstanceOf(BadRequestError);
      await expect(reader.read("d")).rejects.toBeInstanceOf(BadRequestError);
      await expect(reader.read("t")).rejects.toBeInstanceOf(BadRequestError);
      await expect(reader.read("m")).rejects.toBeInstanceOf(NotFoundError);
      await expect(reader.read("unknown")).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("LocalAiIntakePhotoStorage.readIntakePhoto (Admin content) serves the metadata-free preview for original-source keys", async () => {
    const storage = new LocalAiIntakePhotoStorage(root);
    const served = await storage.readIntakePhoto(key);
    expect(markersIn(served)).toEqual([]);
    expect((await sharp(served).metadata()).format).toBe("webp");
  });
});

describe("GET /api/ai-product-intakes/:id/photos/:photoId/content with an original-source key (route)", () => {
  let app: import("express").Express;
  let db: any;
  const PASSWORD = "correct-password-123";
  let viewerCookie: string;
  let noPermissionCookie: string;
  async function login(email: string) {
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    const setCookie = res.headers["set-cookie"];
    return String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  }
  beforeAll(async () => {
    app = (await import("../src/app")).default;
    db = (await import("../src/db/client")).db;
    const adminAuth = await import("../src/services/adminAuth");
    await adminAuth.createAdminUser(db, { email: "staged-editor@example.com", password: PASSWORD, role: AdminRole.ProductEditor });
    viewerCookie = await login("staged-editor@example.com");
    await adminAuth.createAdminUser(db, { email: "staged-reviewer@example.com", password: PASSWORD, role: AdminRole.AiReviewer });
    noPermissionCookie = await login("staged-reviewer@example.com");
  }, 60_000);
  afterAll(async () => { await rm(routeStagingRoot, { recursive: true, force: true }); });

  async function intakeWithOriginalSource() {
    const intakeId = (await request(app).post("/api/ai-product-intakes").set("Cookie", viewerCookie).send({})).body.id as string;
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
    const photoId = (await request(app).post(`/api/ai-product-intakes/${intakeId}/photos`).set("Cookie", viewerCookie).attach("photo", png, { filename: "a.png", contentType: "image/png" })).body.id as string;
    // No writer produces original-source keys yet: simulate one row of that generation.
    const key = `${randomUUID()}.orig.jpg`;
    await writeFile(path.join(routeStagingRoot, key), await metadataRichJpeg());
    await db.update(aiIntakePhotos).set({ storageKey: key }).where(eq(aiIntakePhotos.id, photoId));
    return { intakeId, photoId, key };
  }

  it("keeps authentication and authorization (401/403)", async () => {
    const { intakeId, photoId } = await intakeWithOriginalSource();
    expect((await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`)).status).toBe(401);
    expect((await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`).set("Cookie", noPermissionCookie)).status).toBe(403);
  });

  it("serves a truthful image/webp preview with no EXIF/GPS/serial and no storage key in headers", async () => {
    const { intakeId, photoId, key } = await intakeWithOriginalSource();
    const res = await request(app).get(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`).set("Cookie", viewerCookie).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(JSON.stringify(res.headers)).not.toContain(key);
    const body = res.body as Buffer;
    expect((await sharp(body).metadata()).format).toBe("webp");
    expect(markersIn(body)).toEqual([]);
  });
});
