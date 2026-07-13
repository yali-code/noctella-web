import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BadRequestError } from "./errors";

export const PRODUCT_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PRODUCT_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface StoredProductPhoto {
  filename: string;
  url: string;
  thumbnailUrl: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface PhotoStorage {
  saveProductPhoto(file: { buffer: Buffer; mimetype: string; size: number }): Promise<StoredProductPhoto>;
  deleteProductPhoto(photo: { url: string; thumbnailUrl: string }): Promise<void>;
}

const uploadRoot = process.env.PRODUCT_PHOTO_DIR ?? path.resolve(process.cwd(), "uploads/product-photos");
const publicBase = "/images/product-photos";

function validateUpload(file: { mimetype: string; size: number }) {
  if (!PRODUCT_PHOTO_MIME_TYPES.includes(file.mimetype as (typeof PRODUCT_PHOTO_MIME_TYPES)[number])) {
    throw new BadRequestError("Product photos must be JPEG, PNG, or WebP images");
  }
  if (file.size > PRODUCT_PHOTO_MAX_BYTES) {
    throw new BadRequestError("Product photos must be 10 MB or smaller");
  }
}

function safeFilename(suffix: string) {
  return `${Date.now()}-${randomUUID()}${suffix}`;
}

function filenameFromUrl(url: string) {
  if (!url.startsWith(`${publicBase}/`)) return undefined;
  const filename = path.basename(url);
  return /^[a-zA-Z0-9._-]+$/.test(filename) ? filename : undefined;
}

export class LocalPhotoStorage implements PhotoStorage {
  async saveProductPhoto(file: { buffer: Buffer; mimetype: string; size: number }): Promise<StoredProductPhoto> {
    validateUpload(file);
    await mkdir(uploadRoot, { recursive: true });

    const base = safeFilename("").replace(/[^a-zA-Z0-9-]/g, "");
    const filename = `${base}.webp`;
    const thumbFilename = `${base}-thumb.webp`;
    const mainPath = path.join(uploadRoot, filename);
    const thumbPath = path.join(uploadRoot, thumbFilename);

    const image = sharp(file.buffer, { failOn: "error" }).rotate();
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new BadRequestError("Uploaded file is not a valid image");

    await image.clone().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toFile(mainPath);
    await image.clone().resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumbPath);

    const output = await sharp(mainPath).metadata();
    return {
      filename,
      url: `${publicBase}/${filename}`,
      thumbnailUrl: `${publicBase}/${thumbFilename}`,
      mimeType: "image/webp",
      sizeBytes: file.size,
      width: output.width ?? metadata.width,
      height: output.height ?? metadata.height,
    };
  }

  async deleteProductPhoto(photo: { url: string; thumbnailUrl: string }): Promise<void> {
    await Promise.all([photo.url, photo.thumbnailUrl].map(async (url) => {
      const filename = filenameFromUrl(url);
      if (filename) await rm(path.join(uploadRoot, filename), { force: true });
    }));
  }
}

export const photoStorage = new LocalPhotoStorage();
export const productPhotoStaticRoot = uploadRoot;
export const productPhotoStaticPath = publicBase;
