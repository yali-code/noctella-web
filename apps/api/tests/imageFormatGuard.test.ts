/**
 * S1-b: unit tests of the decoded-format allowlist helper (magic bytes before any decoder; decoded format after
 * metadata()). Pure: no sharp, no I/O except readImageSignatureHead's own temp file.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_IMAGE_FORMAT_MESSAGE, IMAGE_SIGNATURE_BYTES, ImageFormatRejectedError, assertAllowedDecodedFormat, assertAllowedImageSignature,
  detectImageSignature, readImageSignatureHead,
} from "../src/services/imageFormatGuard";
import { BadRequestError } from "../src/services/errors";

const bytes = (...parts: Array<string | number[]>) => Buffer.concat(parts.map((p) => typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p)));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF\0\x01");
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = bytes("RIFF", [0x24, 0x00, 0x00, 0x00], "WEBPVP8 ");

describe("allowed signatures", () => {
  it.each([["image/jpeg", JPEG, "jpeg"], ["image/png", PNG, "png"], ["image/webp", WEBP, "webp"]] as const)("%s passes and reports %s", (mime, head, format) => {
    expect(detectImageSignature(head)).toBe(format);
    expect(assertAllowedImageSignature(head, mime)).toBe(format);
    expect(assertAllowedImageSignature(head, null)).toBe(format); // allowlist-only mode (W4)
  });
});

describe("rejected signatures (never reach a decoder)", () => {
  const rejected: Array<[string, Buffer]> = [
    ["HEIF (ftyp heic)", bytes([0x00, 0x00, 0x00, 0x18], "ftypheic", [0, 0, 0, 0])],
    ["AVIF (ftyp avif)", bytes([0x00, 0x00, 0x00, 0x1c], "ftypavif", [0, 0, 0, 0])],
    ["SVG (<svg)", bytes("<svg xmlns=\"http://www.w3.org/2000/svg\">")],
    ["SVG (<?xml)", bytes("<?xml version=\"1.0\"?><svg/>")],
    ["GIF87a", bytes("GIF87a", [1, 0, 1, 0, 0, 0])],
    ["GIF89a", bytes("GIF89a", [1, 0, 1, 0, 0, 0])],
    ["TIFF little-endian (II*\\0)", bytes("II*\0", [8, 0, 0, 0, 0, 0, 0, 0])],
    ["TIFF big-endian (MM\\0*)", bytes("MM\0*", [0, 0, 0, 8, 0, 0, 0, 0])],
    ["BMP", bytes("BM", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["empty", Buffer.alloc(0)],
    ["short JPEG prefix", bytes([0xff, 0xd8])],
    ["short PNG prefix", PNG.subarray(0, 7)],
    ["RIFF but not WEBP (WAVE)", bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt ")],
    ["RIFF truncated before the form type", bytes("RIFF", [0x24, 0, 0])],
  ];
  it.each(rejected)("%s is rejected with the generic client error", (_label, head) => {
    expect(detectImageSignature(head)).toBeNull();
    for (const mime of ["image/jpeg", "image/png", "image/webp", null]) {
      const error = (() => { try { assertAllowedImageSignature(head, mime); } catch (e) { return e; } })();
      expect(error).toBeInstanceOf(ImageFormatRejectedError);
      expect(error).toBeInstanceOf(BadRequestError);
      expect(error).toMatchObject({ message: ALLOWED_IMAGE_FORMAT_MESSAGE });
      // Same shape as the existing invalid-media BadRequestError: no status/code, so no path's routing changes.
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("code");
    }
  });
});

describe("declared vs actual", () => {
  it("PNG bytes declared image/jpeg (and every other cross pairing) are rejected", () => {
    expect(() => assertAllowedImageSignature(PNG, "image/jpeg")).toThrow(ImageFormatRejectedError);
    for (const [head, mime] of [[JPEG, "image/png"], [JPEG, "image/webp"], [PNG, "image/webp"], [WEBP, "image/jpeg"], [WEBP, "image/png"]] as const)
      expect(() => assertAllowedImageSignature(head, mime)).toThrow(ALLOWED_IMAGE_FORMAT_MESSAGE);
  });
  it("an unsupported declared MIME type is rejected even for an allowed signature", () => {
    for (const mime of ["image/gif", "image/svg+xml", "image/avif", "image/heic", "application/octet-stream", ""])
      expect(() => assertAllowedImageSignature(JPEG, mime)).toThrow(ImageFormatRejectedError);
  });
  it("a caller-supplied rejection keeps that caller's client error type", () => {
    class PathError extends Error { status = 400; code = "PHOTO_UPLOAD_INVALID"; }
    expect(() => assertAllowedImageSignature(bytes("GIF89a"), "image/jpeg", () => new PathError(ALLOWED_IMAGE_FORMAT_MESSAGE))).toThrow(PathError);
  });
});

describe("decoded format after metadata()", () => {
  it.each([["image/jpeg", "jpeg"], ["image/png", "png"], ["image/webp", "webp"]] as const)("%s with decoded %s passes", (mime, format) => {
    expect(assertAllowedDecodedFormat(format, mime)).toBe(format);
    expect(assertAllowedDecodedFormat(format, null)).toBe(format);
  });
  it.each(["heif", "avif", "svg", "gif", "tiff", "bmp", "jp2", "pdf", "magick", "raw", undefined])("decoded %s is rejected", (format) => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", null]) expect(() => assertAllowedDecodedFormat(format as any, mime)).toThrow(ImageFormatRejectedError);
  });
  it("a decoded format different from the declared type is rejected; allowlist-only accepts any allowed format", () => {
    expect(() => assertAllowedDecodedFormat("png", "image/jpeg")).toThrow(ImageFormatRejectedError);
    expect(assertAllowedDecodedFormat("jpeg", null)).toBe("jpeg");
  });
});

describe("readImageSignatureHead", () => {
  it("reads only the signature bytes, and fewer for a shorter file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s1b-head-"));
    try {
      fs.writeFileSync(path.join(dir, "long"), Buffer.concat([WEBP, Buffer.alloc(1024, 7)]));
      fs.writeFileSync(path.join(dir, "short"), bytes([0xff, 0xd8]));
      const head = await readImageSignatureHead(path.join(dir, "long"));
      expect(head.length).toBe(IMAGE_SIGNATURE_BYTES);
      expect(detectImageSignature(head)).toBe("webp");
      expect((await readImageSignatureHead(path.join(dir, "short"))).length).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
