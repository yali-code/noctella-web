import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { parseStagedKey } from "./aiIntakeStagedKey";
import { runImageOperation } from "./photoUploadAdmission";

/** Longest side of the metadata-free preview served for original-source staged photos. */
export const STAGED_PREVIEW_MAX_SIDE = 2048;

/**
 * #390 Stage 1: the only way staged bytes may leave the private store (Admin content route, AI providers).
 *
 * - Every key that is not an original-source key keeps today's behaviour exactly: the stored bytes are returned
 *   unchanged (the live W3 writer's WebP is already metadata-free).
 * - Original-source keys never return raw bytes: the decoded format must match the key, then the image is
 *   auto-oriented, bounded to STAGED_PREVIEW_MAX_SIDE and re-encoded as WebP with Sharp's default metadata
 *   stripping (no EXIF, GPS, XMP or camera serial). Decoding uses failOn "error" and Sharp's default pixel limit,
 *   inside image admission, from one in-memory read (staged uploads are <=10 MiB), so the format check and the
 *   decode see the same bytes and no decoder file handle outlives the call. Any failure is a fixed, path-free error.
 *
 * `filePath` must already be a contained, lstat-verified regular file (callers use managedFileDeletion's policy).
 */
export async function readStagedPhotoForExposure(filePath: string, storageKey: string): Promise<Buffer> {
  const parsed = parseStagedKey(storageKey);
  if (parsed?.generation !== "original") return readFile(filePath);
  return runImageOperation(async () => {
    try {
      const bytes = await readFile(filePath);
      const metadata = await sharp(bytes, { failOn: "error" }).metadata();
      if (metadata.format !== parsed.format || !metadata.width || !metadata.height) throw new Error("format mismatch");
      return await sharp(bytes, { failOn: "error" })
        .rotate()
        .resize({ width: STAGED_PREVIEW_MAX_SIDE, height: STAGED_PREVIEW_MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 86 })
        .toBuffer();
    } catch {
      throw new Error("Staged AI intake photo could not be read");
    }
  });
}
