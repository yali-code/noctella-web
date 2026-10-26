/**
 * S1-b: enforce the ACTUAL content format on the photo paths, not only the client-declared MIME type, so sharp/libvips
 * never parses HEIF/AVIF, SVG (librsvg), TIFF, GIF, BMP or any other format it happens to support.
 *
 * - assertAllowedImageSignature: magic bytes, checked BEFORE any sharp call (JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A,
 *   WebP RIFF????WEBP) and equal to the declared MIME type.
 * - assertAllowedDecodedFormat: after metadata(), format in {jpeg, png, webp} and equal to the declared MIME type.
 * - declaredMime null = allowlist only (owner decision for W4, whose declared type is derived from the staged key, not
 *   from a client): the content must still be JPEG/PNG/WebP, but need not equal that key-derived type.
 *
 * Both reject with a generic client error (no paths or internals). By default it is a plain BadRequestError with no
 * status and no code - exactly the type W1, W4 and AI-intake already throw for invalid media (validateUpload, "not a
 * valid image") - so every path and mode (route, in-process W4 owner, confined worker) routes a format rejection the
 * way it routed invalid media before S1-b. Callers with their own client error type (W2) pass `reject`.
 */
import { open } from "node:fs/promises";
import { BadRequestError } from "./errors";

export type AllowedImageFormat = "jpeg" | "png" | "webp";
export const ALLOWED_IMAGE_FORMAT_MESSAGE = "Photos must be JPEG, PNG, or WebP images";
/** Bytes needed to recognize every allowed signature (WebP needs 12). */
export const IMAGE_SIGNATURE_BYTES = 12;

/** Deliberately no status/code: routing must stay identical to the existing invalid-media BadRequestError. */
export class ImageFormatRejectedError extends BadRequestError {
  constructor() { super(ALLOWED_IMAGE_FORMAT_MESSAGE); }
}
export type ImageFormatReject = () => Error;
const defaultReject: ImageFormatReject = () => new ImageFormatRejectedError();

const DECLARED: Readonly<Record<string, AllowedImageFormat>> = Object.freeze({ "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The allowed format these leading bytes start with, or null. Pure. */
export function detectImageSignature(head: Buffer): AllowedImageFormat | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= PNG.length && head.subarray(0, PNG.length).equals(PNG)) return "png";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** Magic-byte allowlist, checked before any decoder sees the bytes; must also equal the declared MIME type. */
export function assertAllowedImageSignature(head: Buffer, declaredMime: string | null, reject: ImageFormatReject = defaultReject): AllowedImageFormat {
  const detected = detectImageSignature(head);
  if (!detected || (declaredMime !== null && DECLARED[declaredMime] !== detected)) throw reject();
  return detected;
}

/**
 * Decoded-format allowlist after metadata(); must equal the declared MIME type and, when given, the format the
 * signature check detected for the same input (`expected`), so allowlist-only callers (W4) also reject a disagreement.
 */
export function assertAllowedDecodedFormat(metadataFormat: string | undefined, declaredMime: string | null, reject: ImageFormatReject = defaultReject, expected?: AllowedImageFormat): AllowedImageFormat {
  const allowed = Object.values(DECLARED).find((format) => format === metadataFormat);
  if (!allowed || (declaredMime !== null && DECLARED[declaredMime] !== allowed) || (expected !== undefined && allowed !== expected)) throw reject();
  return allowed;
}

/** Reads only the leading signature bytes of a file (fewer if the file is shorter). */
export async function readImageSignatureHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(IMAGE_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(head, 0, IMAGE_SIGNATURE_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
