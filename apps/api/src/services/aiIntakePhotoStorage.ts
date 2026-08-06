import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BadRequestError, NotFoundError } from "./errors";
import { deleteManagedFile, statManagedFile } from "./managedFileDeletion";

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
   *
   * Sprint 96: hardened to use managedFileDeletion.ts's lstat-based
   * containment/symlink policy instead of a bare rm(path.join(...)) -
   * storageKey is always server-generated (never client input), so this
   * hardening is defense-in-depth, not a fix for a reachable exploit. Throws
   * for any disposition other than "regular_file" (deleted) or
   * "already_absent" (idempotent no-op) - the caller
   * (services/aiIntakePhotos.ts) already wraps this call in a try/catch that
   * swallows any failure behind one fixed, non-sensitive warning, so
   * surfacing an anomalous disposition here (which should never legitimately
   * occur for a server-owned key) is safe and does not change the public
   * DELETE endpoint's success contract.
   */
  deleteIntakePhoto(storageKey: string): Promise<void>;
}

/**
 * Sprint 97: a separate, narrow read capability for serving staged photo
 * bytes to the Admin content endpoint - deliberately not a member of
 * AiIntakePhotoStorage, so every existing upload/delete caller and mock is
 * unaffected. Only ever called with a storageKey already resolved from a
 * scoped DB row (services/aiIntakePhotos.ts's getIntakePhotoContent) - never
 * a client-supplied value.
 */
export interface AiIntakePhotoContentStorage {
  readIntakePhoto(storageKey: string): Promise<Buffer>;
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

export class LocalAiIntakePhotoStorage implements AiIntakePhotoStorage, AiIntakePhotoContentStorage {
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
    const disposition = await deleteManagedFile(this.root, storageKey);
    if (disposition !== "regular_file" && disposition !== "already_absent") {
      throw new Error(`Refusing to delete staged AI intake photo: unexpected disposition "${disposition}"`);
    }
  }

  /**
   * Sprint 97: reads a staged photo's bytes for the Admin content endpoint.
   * Uses the same lstat-based managedFileDeletion.ts classification already
   * proven for delete - never follows a symlink, never reads a directory,
   * never reads outside the contained root. `statManagedFile` (lstat) and
   * this method's own `readFile` are two separate syscalls - this is not
   * claimed to be race-free, only contained and symlink-safe at the moment
   * of the lstat check; the accepted residual local-filesystem TOCTOU window
   * matches the same assumption already accepted for deleteIntakePhoto and
   * every other managedFileDeletion.ts consumer (storageKey is always
   * server-generated, never client input).
   */
  async readIntakePhoto(storageKey: string): Promise<Buffer> {
    const info = await statManagedFile(this.root, storageKey);
    if (info.disposition === "already_absent") {
      throw new NotFoundError("Staged photo file not found");
    }
    if (info.disposition !== "regular_file") {
      // Fixed, non-sensitive message - never includes the disposition-derived path or key.
      throw new Error("Staged AI intake photo could not be read");
    }
    return readFile(info.path!);
  }
}

export const aiIntakePhotoStorage = new LocalAiIntakePhotoStorage();
export const aiIntakePhotoStagingRoot = stagingRoot;
