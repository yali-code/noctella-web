/**
 * #390 Stage 2: feature-flagged original-source W3 staging (AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED, default OFF,
 * not activatable outside test/development) and W4 consumption of mixed staged generations. Synthetic images only.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

// The real W4 writer reads PRODUCT_PHOTO_DIR at module load; point it at a disposable directory before any import.
const { canonicalRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-original-source-canonical-"));
  process.env.PRODUCT_PHOTO_DIR = root;
  return { canonicalRoot: root };
});

import { BadRequestError } from "../src/services/errors";
import { LocalAiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { aiIntakeOriginalSourceStagingConfig } from "../src/services/aiIntakeOriginalSourceStaging";
import { stagedSourceMimeType } from "../src/services/aiIntakeStagedKey";
import { LocalAiIntakePhotoReader } from "../src/ai-intake/photoReader";
import { writeDeterministicProductPhoto } from "../src/services/photoStorage";
import { buildAiIntakePhotoFinalizationManifest } from "../src/use-cases/ai-intake-photo-finalize/useCases";

const FLAG = "AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED";
const ORIGINAL_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.orig\.(jpg|png|webp)$/;
const LEGACY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const MARKERS = ["SERIAL-390-TEST", "GPS-390-DATUM", "SyntheticCam"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const markersIn = (bytes: Buffer) => MARKERS.filter((m) => bytes.includes(Buffer.from(m, "latin1")));

/** Little-endian EXIF: IFD0 (Make, Orientation), Exif IFD (BodySerialNumber), GPS IFD (position + MapDatum marker). */
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

/** 3000x1200 gradient JPEG with orientation 6, GPS, make/serial and a Display P3 profile. */
async function metadataRichJpeg(): Promise<Buffer> {
  const width = 3000, height = 1200, raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 3; raw[i] = x % 256; raw[i + 1] = y % 256; raw[i + 2] = (x + y) % 256; }
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).withIccProfile("p3").jpeg({ quality: 90 }).toBuffer();
  const tiff = exifTiff(6);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, Buffer.from("Exif\0\0", "latin1"), tiff, jpeg.subarray(2)]);
}
const image = (format: "png" | "webp" | "jpeg", width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 150 } } })[format]().toBuffer();

describe("AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED", () => {
  it("is OFF unless exactly \"true\", and never activatable outside test/development", () => {
    for (const raw of [undefined, "", "false"]) expect(aiIntakeOriginalSourceStagingConfig({ [FLAG]: raw, NODE_ENV: "test" } as any)).toMatchObject({ enabled: false, valid: true });
    for (const raw of ["TRUE", "1", "true ", "yes"]) expect(aiIntakeOriginalSourceStagingConfig({ [FLAG]: raw, NODE_ENV: "test" } as any)).toMatchObject({ enabled: false, valid: false });
    expect(aiIntakeOriginalSourceStagingConfig({ [FLAG]: "true", NODE_ENV: "test" } as any).enabled).toBe(true);
    expect(aiIntakeOriginalSourceStagingConfig({ [FLAG]: "true", NODE_ENV: "development" } as any).enabled).toBe(true);
    for (const nodeEnv of ["production", "staging", "", undefined]) {
      expect(aiIntakeOriginalSourceStagingConfig({ [FLAG]: "true", NODE_ENV: nodeEnv } as any)).toMatchObject({ enabled: false, requested: true, activatable: false });
    }
  });

  it("maps staged keys to the verified W4 MIME type; every legacy or unknown key stays image/webp", () => {
    const id = randomUUID();
    expect(stagedSourceMimeType(`${id}.orig.jpg`)).toBe("image/jpeg");
    expect(stagedSourceMimeType(`${id}.orig.png`)).toBe("image/png");
    expect(stagedSourceMimeType(`${id}.orig.webp`)).toBe("image/webp");
    for (const key of [`${id}.webp`, "mock-key-1.webp", `${id}.orig.gif`]) expect(stagedSourceMimeType(key)).toBe("image/webp");
  });
});

describe("W3 writer", () => {
  let root: string;
  const saved = { flag: process.env[FLAG], admission: process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED };
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "noctella-original-source-staging-")); });
  afterEach(async () => {
    process.env[FLAG] = saved.flag; if (saved.flag === undefined) delete process.env[FLAG];
    process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = saved.admission; if (saved.admission === undefined) delete process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED;
    await rm(root, { recursive: true, force: true });
  });
  const store = () => new LocalAiIntakePhotoStorage(root);
  const upload = (buffer: Buffer, mimetype: string) => store().saveIntakePhoto({ buffer, mimetype, size: buffer.length });

  it("flag OFF: unchanged WebP-first output, byte-identical to the established recipe", async () => {
    delete process.env[FLAG];
    const jpeg = await metadataRichJpeg();
    const { storageKey } = await upload(jpeg, "image/jpeg");
    expect(storageKey).toMatch(LEGACY_KEY);
    const expected = await sharp(jpeg, { failOn: "error" }).rotate().webp({ quality: 86 }).toBuffer();
    expect(sha(await readFile(path.join(root, storageKey)))).toBe(sha(expected));
    expect(await readdir(root)).toEqual([storageKey]);
  });

  it("flag ON: JPEG, PNG and WebP uploads are stored byte-identical as private original-source keys", async () => {
    process.env[FLAG] = "true";
    for (const [bytes, mimetype, ext] of [[await metadataRichJpeg(), "image/jpeg", "jpg"], [await image("png"), "image/png", "png"], [await image("webp"), "image/webp", "webp"]] as const) {
      const { storageKey } = await upload(bytes, mimetype);
      expect(storageKey).toMatch(ORIGINAL_KEY);
      expect(storageKey.endsWith(`.orig.${ext}`)).toBe(true);
      expect(sha(await readFile(path.join(root, storageKey)))).toBe(sha(bytes));
      if (process.platform !== "win32") expect((await stat(path.join(root, storageKey))).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(root)).every((name) => ORIGINAL_KEY.test(name))).toBe(true); // no partial left behind
  });

  it("flag ON: mismatched, undecodable, truncated or unsupported content fails closed and leaves nothing", async () => {
    process.env[FLAG] = "true";
    const jpeg = await metadataRichJpeg();
    const cases: Array<[Buffer, string]> = [
      [await image("png"), "image/jpeg"],
      [await image("jpeg"), "image/webp"],
      [await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).tiff().toBuffer(), "image/png"],
      [Buffer.from("definitely not an image"), "image/jpeg"],
      [jpeg.subarray(0, Math.floor(jpeg.length / 3)), "image/jpeg"],
      [jpeg, "image/gif"],
    ];
    for (const [bytes, mimetype] of cases) await expect(upload(bytes, mimetype)).rejects.toBeInstanceOf(BadRequestError);
    expect(await readdir(root)).toEqual([]);
  });

  it("flag ON: animated WebP keeps the WebP-first path (first frame, legacy key)", async () => {
    process.env[FLAG] = "true";
    const frame = (r: number) => sharp({ create: { width: 20, height: 10, channels: 3, background: { r, g: 0, b: 0 } } }).png().toBuffer();
    const animated = await sharp([await frame(255), await frame(0)], { join: { animated: true } }).webp().toBuffer(); // distinct frames (identical ones are merged)
    expect((await sharp(animated).metadata()).pages).toBe(2);
    const { storageKey } = await upload(animated, "image/webp");
    expect(storageKey).toMatch(LEGACY_KEY);
  });

  it("flag ON: the disk-ingress path copies the validated file; an abort before publication leaves nothing", async () => {
    process.env[FLAG] = "true";
    process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = "true";
    const jpeg = await metadataRichJpeg();
    const workDir = await mkdtemp(path.join(os.tmpdir(), "noctella-original-source-ingress-"));
    try {
      await writeFile(path.join(workDir, "input"), jpeg);
      const input = { path: path.join(workDir, "input"), workDir, mimetype: "image/jpeg", size: jpeg.length };
      const { storageKey } = await store().saveStagedIntakePhoto({ ...input, signal: new AbortController().signal });
      expect(storageKey).toMatch(ORIGINAL_KEY);
      expect(sha(await readFile(path.join(root, storageKey)))).toBe(sha(jpeg));
      const aborted = new AbortController(); aborted.abort();
      await expect(store().saveStagedIntakePhoto({ ...input, signal: aborted.signal })).rejects.toThrow();
      expect(await readdir(root)).toEqual([storageKey]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("W4 finalization with mixed staged generations (real reader, real deterministic writer)", () => {
  let root: string;
  afterEach(async () => { delete process.env[FLAG]; await rm(root, { recursive: true, force: true }); });
  afterAll(async () => { await rm(canonicalRoot, { recursive: true, force: true }); });

  it("finalizes legacy and original-source photos with the verified MIME, equal orientation, no metadata, original-size sizeBytes and idempotent retries", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "noctella-original-source-w4-"));
    const jpeg = await metadataRichJpeg();
    const storage = new LocalAiIntakePhotoStorage(root);
    delete process.env[FLAG];
    const legacy = await storage.saveIntakePhoto({ buffer: jpeg, mimetype: "image/jpeg", size: jpeg.length });
    process.env[FLAG] = "true";
    const original = await storage.saveIntakePhoto({ buffer: jpeg, mimetype: "image/jpeg", size: jpeg.length });
    const staged = [{ id: randomUUID(), storageKey: legacy.storageKey }, { id: randomUUID(), storageKey: original.storageKey }];
    const keys = Object.fromEntries(staged.map((s) => [s.id, s.storageKey]));
    const reader = new LocalAiIntakePhotoReader({ resolve: async (id) => keys[id] ?? null }, root);
    const labels: string[] = [];
    const deps = {
      readStagedPhotoBytes: (id: string) => reader.read(id),
      writeDeterministicPhoto: (input: Parameters<typeof writeDeterministicProductPhoto>[0]) => { labels.push(input.mimetype); return writeDeterministicProductPhoto(input); },
    };
    const productId = randomUUID();
    const entries = await buildAiIntakePhotoFinalizationManifest(deps, staged, productId, undefined);

    expect(labels).toEqual(["image/webp", "image/jpeg"]);
    const [fromLegacy, fromOriginal] = entries;
    expect([fromLegacy.width, fromLegacy.height]).toEqual([800, 2000]); // orientation 6 applied once (portrait)
    expect([fromOriginal.width, fromOriginal.height]).toEqual([800, 2000]);
    expect(fromOriginal.sizeBytes).toBe(jpeg.length); // the upload size, as for W1 product uploads
    expect(fromLegacy.sizeBytes).toBe((await stat(path.join(root, legacy.storageKey))).size); // unchanged semantics
    for (const entry of entries) {
      for (const key of [entry.mainStorageKey, entry.thumbnailStorageKey]) {
        const bytes = await readFile(path.join(canonicalRoot, key));
        const meta = await sharp(bytes).metadata();
        expect(meta.format).toBe("webp");
        expect(meta.exif).toBeUndefined();
        expect(meta.icc).toBeUndefined();
        expect(markersIn(bytes)).toEqual([]);
      }
    }
    const thumb = await sharp(await readFile(path.join(canonicalRoot, fromOriginal.thumbnailStorageKey))).metadata();
    expect([thumb.width, thumb.height]).toEqual([160, 400]);

    const before = await Promise.all(entries.flatMap((e) => [e.mainStorageKey, e.thumbnailStorageKey]).map(async (k) => sha(await readFile(path.join(canonicalRoot, k)))));
    const retried = await buildAiIntakePhotoFinalizationManifest(deps, staged, productId, undefined);
    expect(retried).toEqual(entries);
    const after = await Promise.all(entries.flatMap((e) => [e.mainStorageKey, e.thumbnailStorageKey]).map(async (k) => sha(await readFile(path.join(canonicalRoot, k)))));
    expect(after).toEqual(before);
    expect(sha(await readFile(path.join(root, original.storageKey)))).toBe(sha(jpeg)); // W4 never modifies the private original
  }, 120_000);
});
