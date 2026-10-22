/**
 * FAZ A #424 work package D: EXIF / GPS stripping and orientation in three product-photo recipe/storage functions.
 * A customer JPEG carrying GPS coordinates, an EXIF text sentinel and orientation 6 must produce main and thumbnail
 * WebP files with no EXIF/XMP/GPS bytes, already rotated. Covers the W2 fenced recipe, the W2 legacy
 * staged writer and the W4 deterministic recipe. Disposable files only; no live-route or confined-worker acceptance.
 */
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalStagedProductPhotoStorage, stagedProductPhotoStorage } from "../src/services/stagedProductPhotoStorage";
import { prepareDeterministicProductPhotoFiles } from "../src/services/photoStorage";

const root = mkdtempSync(path.join(os.tmpdir(), "noctella-metadata-strip-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
const SENTINEL = "NOCTELLA-PRIVATE-GPS-SENTINEL";

/** 300x200 stored, EXIF orientation 6 (display 200x300), GPS IFD and an IFD0 text sentinel. */
async function customerJpeg(): Promise<Buffer> {
  const left = await sharp({ create: { width: 150, height: 200, channels: 3, background: "#d02020" } }).png().toBuffer();
  return sharp({ create: { width: 300, height: 200, channels: 3, background: "#2040d0" } })
    .composite([{ input: left, left: 0, top: 0 }])
    .jpeg()
    .withExif({ IFD0: { ImageDescription: SENTINEL, Copyright: SENTINEL }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "41/1 0/1 30/1", GPSLongitudeRef: "E", GPSLongitude: "28/1 58/1 0/1" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

async function expectStripped(file: string, display: { width: number; height: number }) {
  const bytes = readFileSync(file);
  const meta = await sharp(bytes).metadata();
  expect(meta.format).toBe("webp");
  expect(meta.exif).toBeUndefined();
  expect(meta.xmp).toBeUndefined();
  expect(meta.orientation === undefined || meta.orientation === 1).toBe(true); // pixels already rotated
  expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
  expect(bytes.includes(Buffer.from("Exif\0\0"))).toBe(false);
  expect(bytes.includes(Buffer.from("EXIF"))).toBe(false); // WebP EXIF chunk
  expect(bytes.includes(Buffer.from("XMP "))).toBe(false); // WebP XMP chunk
  expect(meta.width! / meta.height!).toBeCloseTo(display.width / display.height, 2);
  // Auto-orientation: orientation 6 rotates the red left half to the TOP of the displayed image.
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const top = at(Math.floor(info.width / 2), Math.floor(info.height * 0.1)), bottom = at(Math.floor(info.width / 2), Math.floor(info.height * 0.9));
  expect(top[0]).toBeGreaterThan(top[2]); // red
  expect(bottom[2]).toBeGreaterThan(bottom[0]); // blue
}

describe("product photo metadata stripping", () => {
  it("the fixture really carries EXIF GPS, the sentinel and orientation 6 (precondition)", async () => {
    const input = await customerJpeg();
    const meta = await sharp(input).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([300, 200, 6]);
    expect(meta.exif).toBeDefined();
    expect(input.includes(Buffer.from(SENTINEL))).toBe(true);
    // GPSInfo IFD pointer tag 0x8825 present, in the EXIF block's own byte order ("II" little / "MM" big endian).
    const littleEndian = meta.exif!.includes(Buffer.from("II*\0"));
    expect(meta.exif!.includes(Buffer.from(littleEndian ? [0x25, 0x88] : [0x88, 0x25]))).toBe(true);
  });

  const staged = async (name: string) => {
    const workDir = path.join(root, name); mkdirSync(workDir, { recursive: true });
    const input = await customerJpeg(); writeFileSync(path.join(workDir, "input"), input);
    return { path: path.join(workDir, "input"), workDir, mimetype: "image/jpeg", size: input.length, signal: new AbortController().signal };
  };

  it("W2 fenced owner recipe (prepareFencedProductPhoto): main and thumbnail are stripped and rotated", async () => {
    const out = path.join(root, "w2-fenced-out"); mkdirSync(out);
    const result = await stagedProductPhotoStorage.prepareFencedProductPhoto(await staged("w2-fenced"), out);
    expect([result.width, result.height]).toEqual([200, 300]);
    await expectStripped(result.main, { width: 200, height: 300 });
    await expectStripped(result.thumb, { width: 200, height: 300 });
  });

  it("W2 legacy staged writer (fencing OFF): published main and thumbnail are stripped and rotated", async () => {
    const canonical = path.join(root, "w2-legacy-photos"); mkdirSync(canonical);
    const stored = await new LocalStagedProductPhotoStorage(canonical).saveStagedProductPhoto(await staged("w2-legacy"));
    await expectStripped(path.join(canonical, path.basename(stored.url)), { width: 200, height: 300 });
    await expectStripped(path.join(canonical, path.basename(stored.thumbnailUrl)), { width: 200, height: 300 });
  });

  it("W4 fenced/deterministic recipe (prepareDeterministicProductPhotoFiles): main and thumbnail are stripped and rotated", async () => {
    const out = path.join(root, "w4-out"); mkdirSync(out);
    const input = await customerJpeg();
    const result = await prepareDeterministicProductPhotoFiles({ buffer: input, mimetype: "image/jpeg", size: input.length }, out);
    expect([result.width, result.height]).toEqual([200, 300]);
    await expectStripped(result.main, { width: 200, height: 300 });
    await expectStripped(result.thumb, { width: 200, height: 300 });
  });
});
