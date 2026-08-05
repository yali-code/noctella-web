import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BadRequestError } from "./errors";

/**
 * Sprint 91: a dedicated, minimal storage implementation for AiIntakePhoto -
 * deliberately NOT a reuse of services/photoStorage.ts (which is the
 * canonical, public ProductPhoto storage lifecycle with dual main+thumbnail
 * output). Staged intake photos are private (no static route serves this
 * directory - see app.ts, which mounts only productPhotoStaticRoot), have no
 * thumbnail, and are not resized - only converted to WebP, matching the
 * approved Sprint 91 data model (no width/height/thumbnail columns).
 */
export const AI_INTAKE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const AI_INTAKE_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface StoredAiIntakePhoto {
  storageKey: string;
}

export interface AiIntakePhotoStorage {
  saveIntakePhoto(file: { buffer: Buffer; mimetype: string; size: number }): Promise<StoredAiIntakePhoto>;
  /**
   * Sprint 95 final correction: deletes the staged source file - always
   * called AFTER the owning ai_intake_photos row has already been deleted in
   * a committed database transaction (services/aiIntakePhotos.ts's
   * deleteIntakePhoto), never before. Idempotent - an already-missing file
   * is not an error (matches this method's original Sprint 91 contract
   * exactly; no quarantine/tombstone concept exists here or anywhere in this
   * file - a committed DB delete is the only source of truth for whether a
   * staged photo has been deleted, and no filesystem mutation ever needs to
   * be undone, since none happens before commit).
   */
  deleteIntakePhoto(storageKey: string): Promise<void>;
}

const stagingRoot = process.env.AI_INTAKE_PHOTO_DIR ?? path.resolve(process.cwd(), "uploads/ai-intake-photos-private");

function validateUpload(file: { mimetype: string; size: number }) {
  if (!AI_INTAKE_PHOTO_MIME_TYPES.includes(file.mimetype as (typeof AI_INTAKE_PHOTO_MIME_TYPES)[number])) {
    throw new BadRequestError("Staged intake photos must be JPEG, PNG, or WebP images");
  }
  if (file.size > AI_INTAKE_PHOTO_MAX_BYTES) {
    throw new BadRequestError("Staged intake photos must be 10 MB or smaller");
  }
}

export class LocalAiIntakePhotoStorage implements AiIntakePhotoStorage {
  /**
   * Root defaults to the module-level private staging directory; an explicit
   * root may be passed (e.g. in tests, to write into an isolated mkdtemp
   * directory instead of the real repository-local staging path).
   */
  constructor(private readonly root: string = stagingRoot) {}

  async saveIntakePhoto(file: { buffer: Buffer; mimetype: string; size: number }): Promise<StoredAiIntakePhoto> {
    validateUpload(file);
    await mkdir(this.root, { recursive: true });

    const storageKey = `${randomUUID()}.webp`;
    const filePath = path.join(this.root, storageKey);

    const image = sharp(file.buffer, { failOn: "error" }).rotate();
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new BadRequestError("Uploaded file is not a valid image");

    await image.webp({ quality: 86 }).toFile(filePath);

    return { storageKey };
  }

  async deleteIntakePhoto(storageKey: string): Promise<void> {
    await rm(path.join(this.root, storageKey), { force: true });
  }
}

export const aiIntakePhotoStorage = new LocalAiIntakePhotoStorage();
export const aiIntakePhotoStagingRoot = stagingRoot;
