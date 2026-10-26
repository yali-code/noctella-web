/**
 * S1-b per-path proof of the decoded-format allowlist: W2 staged encode, W4 processProductPhoto /
 * prepareDeterministicProductPhotoFiles (allowlist only, owner decision) with the W1 legacy upload staying strict,
 * AI-intake #saveIntakePhotoUnadmitted (buffer and staged-file ingress), and the confined worker's protocol line.
 * A disguised file is rejected with the path's existing invalid-media client error (W2: PhotoUploadError 400; W1/W4/
 * AI-intake: plain BadRequestError), sharp is never called for a rejected signature, nothing is written, and valid
 * inputs keep byte-identical recipe outputs. Owner-level routing is pinned in w4FormatRejectionRouting.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Counting pass-through: every sharp(...) construction is recorded; behaviour and statics are the real module's.
const sharpCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("sharp", async (importOriginal) => {
  const real = ((await importOriginal()) as any).default;
  const counted = Object.assign((...args: any[]) => { sharpCalls.count++; return real(...args); }, real);
  return { default: counted };
});

import sharp from "sharp";
import { LocalStagedProductPhotoStorage, photoStorageError } from "../src/services/stagedProductPhotoStorage";
import { LocalPhotoStorage, prepareDeterministicProductPhotoFiles, productPhotoStaticRoot } from "../src/services/photoStorage";
import { LocalAiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { productPhotoDerivative, productPhotoImage } from "../src/services/photoProcessingRecipe";
import { PhotoUploadError, runImageOperation } from "../src/services/photoUploadAdmission";
import { ALLOWED_IMAGE_FORMAT_MESSAGE, ImageFormatRejectedError } from "../src/services/imageFormatGuard";
import { BadRequestError } from "../src/services/errors";

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-s1b-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
beforeEach(() => { sharpCalls.count = 0; });

const raster = (format: "jpeg" | "png" | "webp" | "gif" | "tiff" | "avif") =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 80, b: 40 } } }).toFormat(format).toBuffer();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');
const XML_SVG = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n'), SVG]);
const BMP = Buffer.concat([Buffer.from("BM", "latin1"), Buffer.alloc(64)]);
const HEIF = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheicmif1heic", "latin1"), Buffer.alloc(64)]);

/** Disguised inputs, each declared as an allowed type. PNG-declared-JPEG is a real allowed format with the wrong label. */
async function disguised(): Promise<Array<[string, Buffer, string]>> {
  return [
    ["GIF declared image/png", await raster("gif"), "image/png"],
    ["TIFF declared image/jpeg", await raster("tiff"), "image/jpeg"],
    ["AVIF declared image/webp", await raster("avif"), "image/webp"],
    ["HEIF ftyp declared image/jpeg", HEIF, "image/jpeg"],
    ["SVG declared image/png", SVG, "image/png"],
    ["XML SVG declared image/webp", XML_SVG, "image/webp"],
    ["BMP declared image/jpeg", BMP, "image/jpeg"],
    ["RIFF/WAVE declared image/webp", Buffer.concat([Buffer.from("RIFF\x24\0\0\0WAVEfmt ", "latin1"), Buffer.alloc(32)]), "image/webp"],
    ["PNG declared image/jpeg", await raster("png"), "image/jpeg"],
  ];
}
const listing = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
const rejection = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error as any; } throw new Error("expected a rejection"); };

describe("W2 staged encode (LocalStagedProductPhotoStorage)", () => {
  function staged(bytes: Buffer, mimetype: string) {
    const root = temp(), workDir = path.join(root, "stage"), outDir = path.join(root, "out"), canonical = path.join(root, "canonical");
    fs.mkdirSync(workDir); fs.mkdirSync(outDir); fs.writeFileSync(path.join(workDir, "input"), bytes);
    return { outDir, canonical, file: { path: path.join(workDir, "input"), workDir, mimetype, size: bytes.length, signal: new AbortController().signal } };
  }

  it("rejects every disguised input with PhotoUploadError 400 before sharp, writing nothing (fenced and publishing paths)", async () => {
    for (const [label, bytes, mime] of await disguised()) {
      const f = staged(bytes, mime);
      const publish = vi.fn(); const encode = vi.fn();
      const storage = new LocalStagedProductPhotoStorage(f.canonical, publish as any, encode as any);
      sharpCalls.count = 0;
      for (const run of [() => storage.prepareFencedProductPhoto(f.file, f.outDir), () => storage.saveStagedProductPhoto(f.file)]) {
        const error = await rejection(run);
        expect(error, label).toBeInstanceOf(PhotoUploadError);
        expect(error, label).toMatchObject({ status: 400, code: "PHOTO_UPLOAD_INVALID", message: ALLOWED_IMAGE_FORMAT_MESSAGE });
        // Re-mapping (the W2 owner's classification) keeps the client error: never the retryable 503.
        expect(photoStorageError(error).status, label).toBe(400);
      }
      expect(sharpCalls.count, `${label}: sharp never constructed`).toBe(0);
      expect(encode, label).not.toHaveBeenCalled();
      expect(publish, label).not.toHaveBeenCalled();
      expect(listing(f.outDir), label).toEqual([]);
      expect(listing(f.canonical), label).toEqual([]);
    }
  });

  it.each(["jpeg", "png", "webp"] as const)("valid %s keeps byte-identical recipe outputs", async (format) => {
    const bytes = await raster(format);
    const f = staged(bytes, `image/${format}`);
    const prepared = await new LocalStagedProductPhotoStorage(f.canonical).prepareFencedProductPhoto(f.file, f.outDir);
    const expected = await runImageOperation(async () => {
      const image = productPhotoImage(bytes, { limitInputPixels: 24_000_000, pages: 1, animated: false });
      const dir = temp();
      await productPhotoDerivative(image).toFile(path.join(dir, "main.webp"));
      await productPhotoDerivative(image, true).toFile(path.join(dir, "thumb.webp"));
      return [fs.readFileSync(path.join(dir, "main.webp")), fs.readFileSync(path.join(dir, "thumb.webp"))];
    });
    expect(fs.readFileSync(prepared.main).equals(expected[0])).toBe(true);
    expect(fs.readFileSync(prepared.thumb).equals(expected[1])).toBe(true);
  });
});

describe("W4 processProductPhoto / prepareDeterministicProductPhotoFiles (allowlist only) and W1 (strict)", () => {
  it("rejects every disguised non-allowed format with the 400 client error before sharp, writing nothing", async () => {
    for (const [label, bytes, mime] of await disguised()) {
      if (label.startsWith("PNG declared")) continue; // an allowed format: W4 is allowlist only (see next test)
      const outDir = temp();
      sharpCalls.count = 0;
      const error = await rejection(() => prepareDeterministicProductPhotoFiles({ buffer: bytes, mimetype: mime, size: bytes.length }, outDir));
      expect(error, label).toBeInstanceOf(ImageFormatRejectedError);
      expect(error, label).toBeInstanceOf(BadRequestError);
      // Same plain BadRequestError as validateUpload's invalid-media rejection (no status/code): W4 routing unchanged.
      expect(error, label).toMatchObject({ message: ALLOWED_IMAGE_FORMAT_MESSAGE });
      expect(error, label).not.toHaveProperty("status");
      expect(sharpCalls.count, `${label}: sharp never constructed`).toBe(0);
      expect(listing(outDir), label).toEqual([]);
    }
  });

  it("accepts an allowed format whose key-derived declared type differs (JPEG staged as .webp), byte-identical to the recipe", async () => {
    const bytes = await raster("jpeg");
    const outDir = temp();
    sharpCalls.count = 0;
    const prepared = await prepareDeterministicProductPhotoFiles({ buffer: bytes, mimetype: "image/webp", size: bytes.length }, outDir);
    expect(sharpCalls.count, "positive control: the counting wrapper sees real recipe calls").toBeGreaterThan(0);
    const [main, thumb] = await runImageOperation(async () => {
      const image = productPhotoImage(bytes);
      return [await productPhotoDerivative(image).toBuffer(), await productPhotoDerivative(image, true).toBuffer()];
    });
    expect(fs.readFileSync(prepared.main).equals(main)).toBe(true);
    expect(fs.readFileSync(prepared.thumb).equals(thumb)).toBe(true);
  });

  it("W1 legacy client upload stays strict: PNG bytes declared image/jpeg and a GIF are rejected before sharp, nothing written", async () => {
    const before = listing(productPhotoStaticRoot);
    for (const [bytes, mime] of [[await raster("png"), "image/jpeg"], [await raster("gif"), "image/png"]] as const) {
      sharpCalls.count = 0;
      const error = await rejection(() => new LocalPhotoStorage().saveProductPhoto({ buffer: bytes, mimetype: mime, size: bytes.length }));
      expect(error).toBeInstanceOf(ImageFormatRejectedError);
      expect(error).toBeInstanceOf(BadRequestError);
      expect(sharpCalls.count).toBe(0);
    }
    expect(listing(productPhotoStaticRoot)).toEqual(before);
  });
});

describe("AI-intake #saveIntakePhotoUnadmitted", () => {
  it("rejects every disguised input (buffer ingress) with the 400 client error before sharp, writing nothing", async () => {
    for (const [label, bytes, mime] of await disguised()) {
      const root = temp();
      sharpCalls.count = 0;
      const error = await rejection(() => new LocalAiIntakePhotoStorage(root).saveIntakePhoto({ buffer: bytes, mimetype: mime, size: bytes.length }));
      expect(error, label).toBeInstanceOf(ImageFormatRejectedError);
      expect(error, label).toBeInstanceOf(BadRequestError);
      expect(error, label).toMatchObject({ message: ALLOWED_IMAGE_FORMAT_MESSAGE });
      expect(sharpCalls.count, `${label}: sharp never constructed`).toBe(0);
      expect(listing(root), label).toEqual([]);
    }
  });

  it("rejects a disguised staged file (disk ingress) the same way", async () => {
    vi.stubEnv("PRODUCT_PHOTO_DISK_STAGING_ENABLED", "true");
    const bytes = await raster("gif");
    const base = temp(), root = path.join(base, "intake"), workDir = path.join(base, "stage");
    fs.mkdirSync(workDir); fs.writeFileSync(path.join(workDir, "input"), bytes);
    sharpCalls.count = 0;
    const error = await rejection(() => new LocalAiIntakePhotoStorage(root).saveStagedIntakePhoto(
      { path: path.join(workDir, "input"), workDir, mimetype: "image/png", size: bytes.length, signal: new AbortController().signal }));
    expect(error).toBeInstanceOf(ImageFormatRejectedError);
    expect(sharpCalls.count).toBe(0);
    expect(listing(root)).toEqual([]);
  });

  it.each(["jpeg", "png", "webp"] as const)("valid %s keeps the byte-identical WebP-first output", async (format) => {
    const bytes = await raster(format);
    const root = temp();
    const { storageKey } = await new LocalAiIntakePhotoStorage(root).saveIntakePhoto({ buffer: bytes, mimetype: `image/${format}`, size: bytes.length });
    const dir = temp();
    await sharp(bytes, { failOn: "error" }).rotate().webp({ quality: 86 }).toFile(path.join(dir, "expected.webp"));
    expect(fs.readFileSync(path.join(root, storageKey)).equals(fs.readFileSync(path.join(dir, "expected.webp")))).toBe(true);
  });
});

describe("confined preparation worker protocol (unconfined child, same script)", () => {
  const runWorker = (job: object) => spawnSync(process.execPath, ["--import", "tsx", path.join("src", "workers", "photoPreparationWorker.ts")], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PHOTO_PREPARATION_JOB: Buffer.from(JSON.stringify(job)).toString("base64") },
  });
  const lastLine = (stdout: string) => JSON.parse(stdout.trim().split(/\r?\n/).pop()!);

  it("a W4 job on a disguised source reports exactly the existing invalid-media line (status/code), and writes nothing", async () => {
    const job = async (bytes: Buffer) => {
      const dir = temp(), outDir = path.join(dir, "out"); fs.mkdirSync(outDir);
      fs.writeFileSync(path.join(dir, "source"), bytes);
      const run = runWorker({ kind: "w4", inputPath: path.join(dir, "source"), mimetype: "image/webp", outDir });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(3); // a reported failure, not a crash (the parent gets a result line)
      expect(listing(outDir)).toEqual([]);
      return lastLine(run.stdout);
    };
    // Baseline: validateUpload's pre-S1-b invalid-media BadRequestError (oversize source) inside the same worker.
    const baseline = await job(Buffer.alloc(10 * 1024 * 1024 + 1, 0xff));
    const rejected = await job(await raster("gif"));
    expect(rejected).toEqual({ ok: false, status: 500, code: "PHOTO_PREPARATION_FAILED", message: ALLOWED_IMAGE_FORMAT_MESSAGE });
    expect([rejected.ok, rejected.status, rejected.code]).toEqual([baseline.ok, baseline.status, baseline.code]);
  }, 90_000);

  it("a W2 job on a disguised input reports its existing 400 PHOTO_UPLOAD_INVALID outcome and writes nothing", async () => {
    const dir = temp(), workDir = path.join(dir, "stage"), outDir = path.join(dir, "out"); fs.mkdirSync(workDir); fs.mkdirSync(outDir);
    const bytes = await raster("tiff"); fs.writeFileSync(path.join(workDir, "input"), bytes);
    const run = runWorker({ kind: "w2", inputPath: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", outDir });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(3);
    expect(lastLine(run.stdout)).toEqual({ ok: false, status: 400, code: "PHOTO_UPLOAD_INVALID", message: ALLOWED_IMAGE_FORMAT_MESSAGE });
    expect(listing(outDir)).toEqual([]);
  }, 90_000);
});
