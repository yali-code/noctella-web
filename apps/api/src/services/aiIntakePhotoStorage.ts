import { imageAdmissionEnabled, PhotoUploadError, runImageOperation } from "./photoUploadAdmission";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, open, rm, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { BadRequestError, NotFoundError } from "./errors";
import { abortedError } from "./photoUploadAdmission";
import type { StagedProductPhotoInput } from "./stagedProductPhotoStorage";
import { deleteManagedFile, statManagedFile } from "./managedFileDeletion";
import { readStagedPhotoForExposure } from "./aiIntakeStagedExposure";
import { originalSourceKeyParts } from "./aiIntakeStagedKey";
import { IMAGE_SIGNATURE_BYTES, assertAllowedDecodedFormat, assertAllowedImageSignature, readImageSignatureHead } from "./imageFormatGuard";
import { aiIntakeOriginalSourceStagingEnabled } from "./aiIntakeOriginalSourceStaging";

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
    return runImageOperation(() => this.#saveIntakePhotoUnadmitted(file));
  }
  /** Internal disk-ingress capability. The established Buffer interface remains unchanged. */
  async saveStagedIntakePhoto(file: StagedProductPhotoInput): Promise<StoredAiIntakePhoto> {
    return runImageOperation(async () => {
      if (!imageAdmissionEnabled()) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Disk intake processing is disabled");
      if (file.signal.aborted) throw abortedError();
      // File-cache handles can outlive native work and prevent private ingress cleanup.
      sharp.cache({ files: 0 });
      validateUpload(file);
      const info = await lstat(file.path);
      if (path.dirname(file.path) !== file.workDir || path.basename(file.path) !== "input" || info.isSymbolicLink() || !info.isFile() || await realpath(file.path) !== path.resolve(file.path) || info.size !== file.size) {
        throw new BadRequestError("Invalid staged intake photo");
      }
      return this.#saveIntakePhotoUnadmitted(file);
    });
  }
  async #saveIntakePhotoUnadmitted(file: { buffer: Buffer; mimetype: string; size: number } | StagedProductPhotoInput): Promise<StoredAiIntakePhoto> {
    validateUpload(file);
    await mkdir(this.root, { recursive: true });
    // S1-b: actual content must be JPEG/PNG/WebP and match the declared type before any decoder (either path) sees it.
    const detected = assertAllowedImageSignature("buffer" in file ? file.buffer.subarray(0, IMAGE_SIGNATURE_BYTES) : await readImageSignatureHead(file.path), file.mimetype);

    // #390: original-source staging (default OFF, not activatable in production); null keeps the WebP-first path.
    if (aiIntakeOriginalSourceStagingEnabled()) {
      const original = await this.#saveOriginalSourceUnadmitted(file);
      if (original) return original;
    }

    const storageKey = `${randomUUID()}.webp`;
    const filePath = path.join(this.root, storageKey);

    let owned = false;
    try {
      const image = sharp("buffer" in file ? file.buffer : file.path, { failOn: "error" }).rotate();
      const metadata = await image.metadata();
      assertAllowedDecodedFormat(metadata.format, file.mimetype, undefined, detected);
      if (!metadata.width || !metadata.height) throw new BadRequestError("Uploaded file is not a valid image");
      if (imageAdmissionEnabled()) {
        const reserved = await open(filePath, "wx", 0o600);
        owned = true;
        await reserved.close();
      }
      await image.webp({ quality: 86 }).toFile(filePath);
      if ("signal" in file && file.signal.aborted) throw abortedError();
      return { storageKey };
    } catch (error) {
      if (owned) {
        try { await rm(filePath, { force: true }); }
        catch { throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Private photo cleanup failed"); }
      }
      throw error;
    }
  }

  /**
   * #390 Stage 2: stores the validated upload unchanged as `${uuid}.orig.(jpg|png|webp)` instead of a full-resolution
   * WebP re-encode (whose libwebp token buffer exceeds the 384 MiB budget at 24 MP). The content must decode as the
   * declared allow-listed format (stricter than the WebP-first path, which accepts any decodable format) and must
   * fully decode under failOn "error" and the default pixel limit, without an output encode. Animated WebP returns
   * null so the caller keeps the WebP-first path (first frame, metadata-free) unchanged.
   *
   * Write protocol: 0600 exclusive `.${uuid}.partial` -> fsync -> link() (never replaces an existing key) -> unlink
   * the partial -> directory fsync. A failure before publication removes the partial; a crash can leave only a
   * partial, which the orphan sweep recognises. Stored originals keep EXIF/GPS metadata: they are exposed only through
   * readStagedPhotoForExposure's metadata-free preview, and W4 reads them privately.
   */
  async #saveOriginalSourceUnadmitted(file: { buffer: Buffer; mimetype: string; size: number } | StagedProductPhotoInput): Promise<StoredAiIntakePhoto | null> {
    const parts = originalSourceKeyParts(file.mimetype);
    if (!parts) throw new BadRequestError("Staged intake photos must be JPEG, PNG, or WebP images");
    const input = "buffer" in file ? file.buffer : file.path;
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(input, { failOn: "error" }).metadata();
    } catch {
      throw new BadRequestError("Uploaded file is not a valid image");
    }
    if (metadata.format !== parts.format) throw new BadRequestError("Staged intake photos must be JPEG, PNG, or WebP images");
    if (!metadata.width || !metadata.height) throw new BadRequestError("Uploaded file is not a valid image");
    if ((metadata.pages ?? 1) > 1) return null;
    try {
      await sharp(input, { failOn: "error" }).stats();
    } catch {
      throw new BadRequestError("Uploaded file is not a valid image");
    }

    const id = randomUUID();
    const storageKey = `${id}.orig.${parts.ext}`;
    const partial = path.join(this.root, `.${id}.partial`);
    try {
      if ("buffer" in file) {
        if (file.buffer.length !== file.size) throw new BadRequestError("Invalid staged intake photo");
        const handle = await open(partial, "wx", 0o600);
        try { await handle.writeFile(file.buffer); await handle.sync(); } finally { await handle.close(); }
      } else {
        await copyFile(file.path, partial, constants.COPYFILE_EXCL);
        await chmod(partial, 0o600);
        const handle = await open(partial, "r+");
        try {
          if ((await handle.stat()).size !== file.size) throw new BadRequestError("Invalid staged intake photo");
          await handle.sync();
        } finally { await handle.close(); }
      }
      if ("signal" in file && file.signal.aborted) throw abortedError();
      await link(partial, path.join(this.root, storageKey));
    } catch (error) {
      try { await rm(partial, { force: true }); }
      catch { throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Private photo cleanup failed"); }
      throw error;
    }
    // Published. A partial name left by a failed unlink is the same inode and is swept as an unowned partial.
    await unlink(partial).catch(() => undefined);
    if (process.platform === "linux") {
      const directory = await open(this.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
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
    // #390: exposure-safe bytes - legacy staged WebP unchanged; an original-source upload only as a metadata-free preview.
    return readStagedPhotoForExposure(info.path!, storageKey);
  }
}

export const aiIntakePhotoStorage = new LocalAiIntakePhotoStorage();
export const aiIntakePhotoStagingRoot = stagingRoot;
