import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * P2-1 (#373): deterministic synthetic fixtures for the offline product-photo
 * memory benchmark. Every fixture is generated locally from a seeded PRNG or
 * libvips' constant-colour generator - no network, no real product photos.
 */

export type FixtureFormat = "jpeg" | "png" | "webp";

export interface ImageFixtureSpec {
  kind: "image";
  name: string;
  format: FixtureFormat;
  /** MIME type declared to the pipeline, as multer would report it. */
  mimetype: string;
  width: number;
  height: number;
  /** "photo": seeded smooth gradient + noise; "flat": constant colour (decompression stress). */
  content: "photo" | "flat";
  channels?: 3 | 4;
  /** Noise amplitude 0-127 for "photo" content; higher compresses worse. */
  noise?: number;
  quality?: number;
  /** When set, quality is searched downwards so the encoded file fits this many bytes. */
  targetMaxBytes?: number;
  seed?: number;
  tags: string[];
}

export interface InvalidFixtureSpec {
  kind: "invalid";
  name: string;
  mimetype: string;
  variant: "random-bytes" | "truncated" | "text" | "empty" | "oversize" | "mime-mismatch";
  /** For truncated / mime-mismatch: the image fixture whose bytes are reused. */
  source?: string;
  sizeBytes?: number;
  tags: string[];
}

export type FixtureSpec = ImageFixtureSpec | InvalidFixtureSpec;

export interface GeneratedFixture {
  name: string;
  file: string;
  mimetype: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  megapixels?: number;
  format?: FixtureFormat;
  quality?: number;
  sha256: string;
  tags: string[];
  expectValid: boolean;
}

export const PRODUCT_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
/** Fits under the 10 MiB multer/storage limit with headroom. */
export const NEAR_LIMIT_BYTES = Math.floor(9.75 * 1024 * 1024);

/** Mulberry32: tiny deterministic PRNG so fixtures are byte-reproducible for a given sharp/libvips build. */
export function createPrng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raw interleaved pixels: a diagonal colour gradient with seeded per-pixel noise. */
export function photoLikePixels(width: number, height: number, channels: 3 | 4, noise: number, seed: number): Buffer {
  const random = createPrng(seed);
  const pixels = Buffer.allocUnsafe(width * height * channels);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = [(x * 255) / width, (y * 255) / height, ((x + y) * 127) / (width + height) + 64];
      for (let c = 0; c < channels; c += 1) {
        if (c === 3) {
          pixels[offset++] = 255 - Math.floor(random() * 32);
          continue;
        }
        const value = base[c] + (random() * 2 - 1) * noise;
        pixels[offset++] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
  }
  return pixels;
}

function encoder(image: sharp.Sharp, format: FixtureFormat, quality: number) {
  if (format === "jpeg") return image.jpeg({ quality, chromaSubsampling: quality >= 90 ? "4:4:4" : "4:2:0" });
  if (format === "png") return image.png({ compressionLevel: 6 });
  return image.webp({ quality });
}

export async function encodeImageFixture(spec: ImageFixtureSpec): Promise<{ bytes: Buffer; quality?: number }> {
  const channels = spec.channels ?? 3;
  const pixels = spec.content === "photo" ? photoLikePixels(spec.width, spec.height, channels, spec.noise ?? 24, spec.seed ?? 1) : undefined;
  const source = () => pixels
    ? sharp(pixels, { raw: { width: spec.width, height: spec.height, channels } })
    : sharp({ create: { width: spec.width, height: spec.height, channels, background: { r: 120, g: 90, b: 60, alpha: 1 } }, limitInputPixels: false });

  if (spec.format === "png" || !spec.targetMaxBytes) {
    const quality = spec.format === "png" ? undefined : spec.quality ?? 85;
    return { bytes: await encoder(source(), spec.format, quality ?? 0).toBuffer(), quality };
  }
  // Highest quality (searched from spec.quality downwards) whose output fits targetMaxBytes.
  for (let quality = spec.quality ?? 100; quality >= 40; quality -= 2) {
    const bytes = await encoder(source(), spec.format, quality).toBuffer();
    if (bytes.length <= spec.targetMaxBytes) return { bytes, quality };
  }
  throw new Error(`Fixture ${spec.name} cannot fit ${spec.targetMaxBytes} bytes`);
}

export function invalidFixtureBytes(spec: InvalidFixtureSpec, sources: Map<string, Buffer>): Buffer {
  const sourceBytes = () => {
    const bytes = spec.source ? sources.get(spec.source) : undefined;
    if (!bytes) throw new Error(`Fixture ${spec.name} needs source fixture ${spec.source}`);
    return bytes;
  };
  switch (spec.variant) {
    case "random-bytes": {
      const random = createPrng(7);
      const bytes = Buffer.alloc(spec.sizeBytes ?? 256 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
      return bytes;
    }
    case "truncated": {
      const bytes = sourceBytes();
      return Buffer.from(bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
    case "text":
      return Buffer.from("this is not an image\n".repeat(64), "utf8");
    case "empty":
      return Buffer.alloc(0);
    case "oversize":
      return Buffer.alloc(spec.sizeBytes ?? PRODUCT_PHOTO_LIMIT_BYTES + 1, 0xff);
    case "mime-mismatch":
      return Buffer.from(sourceBytes());
  }
}

const INVALID_EXPECTED_VALID: Record<InvalidFixtureSpec["variant"], boolean> = {
  "random-bytes": false,
  truncated: false,
  text: false,
  empty: false,
  oversize: false,
  // Sharp sniffs content, so PNG bytes declared as image/jpeg are expected to process.
  "mime-mismatch": true,
};

export function fixtureExtension(spec: FixtureSpec) {
  if (spec.kind === "image") return spec.format === "jpeg" ? ".jpg" : `.${spec.format}`;
  return ".bin";
}

/** Writes every fixture into dir and returns its manifest (sizes, pixels, SHA-256). */
export async function generateFixtures(specs: FixtureSpec[], dir: string): Promise<GeneratedFixture[]> {
  const generated: GeneratedFixture[] = [];
  const sources = new Map<string, Buffer>();
  for (const spec of specs) {
    let bytes: Buffer;
    let meta: Partial<GeneratedFixture> = {};
    if (spec.kind === "image") {
      const encoded = await encodeImageFixture(spec);
      bytes = encoded.bytes;
      sources.set(spec.name, bytes);
      meta = { width: spec.width, height: spec.height, megapixels: Math.round((spec.width * spec.height) / 10_000) / 100, format: spec.format, quality: encoded.quality };
    } else {
      bytes = invalidFixtureBytes(spec, sources);
    }
    if (spec.kind === "image" && spec.targetMaxBytes && bytes.length > spec.targetMaxBytes) {
      throw new Error(`Fixture ${spec.name} exceeds its declared byte target`);
    }
    if (spec.tags.includes("near-limit") && (bytes.length < 9 * 1024 * 1024 || bytes.length > PRODUCT_PHOTO_LIMIT_BYTES)) {
      throw new Error(`Fixture ${spec.name} must be between 9 and 10 MiB`);
    }
    const file = path.join(dir, `${spec.name}${fixtureExtension(spec)}`);
    await writeFile(file, bytes);
    generated.push({
      name: spec.name,
      file,
      mimetype: spec.mimetype,
      sizeBytes: bytes.length,
      ...meta,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      tags: spec.tags,
      expectValid: ["image/jpeg", "image/png", "image/webp"].includes(spec.mimetype) && bytes.length <= PRODUCT_PHOTO_LIMIT_BYTES && (spec.kind === "image" ? spec.width * spec.height <= 268_402_689 : INVALID_EXPECTED_VALID[spec.variant]),
    });
  }
  return generated;
}
