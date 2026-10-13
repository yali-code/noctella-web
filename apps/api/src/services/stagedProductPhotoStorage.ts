import { randomUUID } from "node:crypto";

import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";


import sharp from "sharp";
import { productPhotoImage, productPhotoDerivative } from "./photoProcessingRecipe";
import { PRODUCT_PHOTO_MAX_BYTES, PRODUCT_PHOTO_MIME_TYPES, productPhotoStaticPath, productPhotoStaticRoot, type StoredProductPhoto } from "./photoStorage";
import { PhotoUploadError, abortedError } from "./photoUploadAdmission";

export const PHOTO_PIXEL_LIMIT = 24_000_000;
export const PHOTO_EDGE_LIMIT = 12_000;
export const PHOTO_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export interface StagedProductPhotoInput { path: string; workDir: string; mimetype: string; size: number; signal: AbortSignal }
export interface StagedProductPhotoStorage {
  saveStagedProductPhoto(input: StagedProductPhotoInput): Promise<StoredProductPhoto>;
  deleteProductPhoto(photo: { url: string; thumbnailUrl: string }): Promise<void>;
}
export function photoStorageError(error: unknown): PhotoUploadError {
  if (error instanceof PhotoUploadError) return error;
  const err = error as { code?: string; message?: string };
  if (err.code || /unable to write|write error|No space left|Permission denied|Input\/output error/i.test(err.message ?? "")) return new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo storage is unavailable");
  if (err.message?.includes("pixel limit")) return new PhotoUploadError(400, "PHOTO_PIXEL_LIMIT", "Photo dimensions exceed the safety limit");
  return new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Photo file is not a valid image");
}
let fileCacheConfigured = false;
export class LocalStagedProductPhotoStorage implements StagedProductPhotoStorage {
  constructor(private readonly root = productPhotoStaticRoot, private readonly publish = link, private readonly encode = (image: sharp.Sharp, destination: string) => image.toFile(destination)) {}
  async saveStagedProductPhoto(input: StagedProductPhotoInput): Promise<StoredProductPhoto> {
    // libvips file-cache handles can outlive metadata() and prevent private-file cleanup on Windows.
    // Activate this process-level file-cache policy only when the gated staged processor is used.
    if (!fileCacheConfigured) { sharp.cache({ files: 0 }); fileCacheConfigured = true; }
    const owned: string[] = [];
    try {
      if (input.signal.aborted) throw abortedError();
      if (!PRODUCT_PHOTO_MIME_TYPES.includes(input.mimetype as any)) throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Product photos must be JPEG, PNG, or WebP images");
      const info = await lstat(input.path);
      if (path.dirname(input.path) !== input.workDir || path.basename(input.path) !== "input" || info.isSymbolicLink() || !info.isFile() || await realpath(input.path) !== path.resolve(input.path)) throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Invalid staged photo");
      if (info.size !== input.size || info.size > PRODUCT_PHOTO_MAX_BYTES) throw new PhotoUploadError(413, "PHOTO_UPLOAD_LIMIT", "Product photos must be 10 MB or smaller");
      const image = productPhotoImage(input.path, { limitInputPixels: PHOTO_PIXEL_LIMIT, pages: 1, animated: false });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > PHOTO_EDGE_LIMIT || metadata.height > PHOTO_EDGE_LIMIT || metadata.width * metadata.height > PHOTO_PIXEL_LIMIT) throw new PhotoUploadError(400, "PHOTO_PIXEL_LIMIT", "Photo dimensions exceed the safety limit");
      const main = path.join(input.workDir, "main.webp");
      const thumb = path.join(input.workDir, "thumb.webp");
      for (const [dest, thumbnail] of [[main, false], [thumb, true]] as const) {
        if (input.signal.aborted) throw abortedError();
        // Sharp stream output uses a complete encoded Buffer in 0.34.5. File output avoids that JS Buffer.
        // Reserve a private, exclusively owned path before libvips opens it for output.
        const reserved = await open(dest, "wx", 0o600); await reserved.close();
        // Abort cannot release native work early; wait for the actual file encoder to settle.
        await this.encode(productPhotoDerivative(image, thumbnail), dest);
        if ((await lstat(dest)).size > PHOTO_OUTPUT_MAX_BYTES) throw new PhotoUploadError(413, "PHOTO_UPLOAD_LIMIT", "Processed photo exceeds the safety limit");
      }
      if (input.signal.aborted) throw abortedError();
      const output = await sharp(main, { limitInputPixels: PHOTO_PIXEL_LIMIT }).metadata();
      await mkdir(this.root, { recursive: true });
      const filename = Date.now() + "-" + randomUUID() + ".webp";
      const thumbFilename = filename.replace(".webp", "-thumb.webp");
      // Atomic no-overwrite publication on the same filesystem. EXDEV fails closed.
      for (const [src, key] of [[main, filename], [thumb, thumbFilename]]) {
        const destination = path.join(this.root, key);
        await this.publish(src, destination);
        owned.push(destination);
      }
      return { filename, url: productPhotoStaticPath + "/" + filename, thumbnailUrl: productPhotoStaticPath + "/" + thumbFilename, mimeType: "image/webp", sizeBytes: input.size, width: output.width!, height: output.height! };
    } catch (error) {
      const cleanup = await Promise.allSettled(owned.map(file => rm(file, { force: true })));
      if (cleanup.some(item => item.status === "rejected")) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo storage cleanup failed");
      throw photoStorageError(error);
    }
  }
  async deleteProductPhoto(photo: { url: string; thumbnailUrl: string }) {
    for (const url of [photo.url, photo.thumbnailUrl]) {
      if (!url.startsWith(productPhotoStaticPath + "/")) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Invalid owned photo URL");
      const name = path.basename(url);
      if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Invalid owned photo key");
      await rm(path.join(this.root, name), { force: true });
    }
  }
}
export const stagedProductPhotoStorage = new LocalStagedProductPhotoStorage();
