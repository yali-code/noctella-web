// #390 EXPERIMENT ONLY (owner-authorized, isolated, non-production): original-source staging for W3 AI intake.
// Stores the validated upload bytes in private staging instead of a full-resolution WebP re-encode.
// Never imported by application code; the offline combined probe installs it on a disposable process only.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readdir, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const ORIGINAL_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** Experimental key shape; deliberately disjoint from the live `${uuid}.webp` staged key and cleanup regex. */
export const ORIGINAL_SOURCE_KEY_RE = new RegExp(`^${UUID}\\.orig\\.(jpg|png|webp)$`);
export const ORIGINAL_SOURCE_PARTIAL_RE = new RegExp(`^\\.${UUID}\\.partial$`);
const FORMATS: Record<string, { format: string; ext: string }> = {
  "image/jpeg": { format: "jpeg", ext: "jpg" },
  "image/png": { format: "png", ext: "png" },
  "image/webp": { format: "webp", ext: "webp" },
};

export class OriginalSourceRejected extends Error {
  constructor(readonly reason: string) { super("Staged intake photo rejected"); }
}

export interface OriginalSourceValidation { ext: string; format: string; width: number; height: number; orientation: number; pages: number; hasExif: boolean; hasIcc: boolean }

/**
 * Strict content validation: allow-listed declared MIME, live size limit, decoded container format must equal the
 * declared MIME, and a complete streaming decode under failOn "error" (the live pipeline's flag and default pixel
 * limit) so truncated or corrupt data fails closed without an output encode.
 */
export async function validateOriginalSource(input: Buffer | string, mimetype: string, size: number): Promise<OriginalSourceValidation> {
  const expected = FORMATS[mimetype];
  if (!expected) throw new OriginalSourceRejected("unsupported-mime");
  if (!Number.isInteger(size) || size <= 0 || size > ORIGINAL_SOURCE_MAX_BYTES) throw new OriginalSourceRejected("size");
  try {
    const meta = await sharp(input, { failOn: "error" }).metadata();
    if (meta.format !== expected.format) throw new OriginalSourceRejected("content-mismatch");
    if (!meta.width || !meta.height) throw new OriginalSourceRejected("no-dimensions");
    await sharp(input, { failOn: "error" }).stats();
    return { ext: expected.ext, format: expected.format, width: meta.width, height: meta.height, orientation: meta.orientation ?? 1, pages: meta.pages ?? 1, hasExif: !!meta.exif, hasIcc: !!meta.icc };
  } catch (error) {
    if (error instanceof OriginalSourceRejected) throw error;
    throw new OriginalSourceRejected("undecodable");
  }
}

/**
 * Validates, then writes the original bytes to a 0600 `.${uuid}.partial` file (exclusive create), fsyncs it,
 * publishes it with link() (fails instead of replacing an existing key) and removes the partial name.
 * Any failure removes the partial file; a crash can leave only `.${uuid}.partial`, which sweepPartials removes.
 */
export async function stageOriginalSource(root: string, file: { buffer?: Buffer; path?: string; mimetype: string; size: number }) {
  const source = file.buffer ?? file.path;
  if (!source) throw new OriginalSourceRejected("missing-input");
  if (file.buffer && file.buffer.length !== file.size) throw new OriginalSourceRejected("size");
  const validation = await validateOriginalSource(source, file.mimetype, file.size);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const storageKey = `${id}.orig.${validation.ext}`;
  const partial = path.join(root, `.${id}.partial`);
  try {
    if (file.buffer) {
      const handle = await open(partial, "wx", 0o600);
      try { await handle.writeFile(file.buffer); await handle.sync(); } finally { await handle.close(); }
    } else {
      await copyFile(file.path!, partial, constants.COPYFILE_EXCL);
      await chmod(partial, 0o600);
      const handle = await open(partial, "r+");
      try { if ((await handle.stat()).size !== file.size) throw new OriginalSourceRejected("size"); await handle.sync(); } finally { await handle.close(); }
    }
    await link(partial, path.join(root, storageKey));
    await unlink(partial);
    if (process.platform === "linux") { // directory fsync makes the published name durable (not supported on Windows)
      const dir = await open(root, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return { storageKey, validation };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function containedRegularFile(root: string, storageKey: string) {
  if (!ORIGINAL_SOURCE_KEY_RE.test(storageKey)) throw new OriginalSourceRejected("invalid-key");
  const file = path.join(root, storageKey);
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || path.dirname(await realpath(file)) !== await realpath(root)) throw new OriginalSourceRejected("unsafe-path");
  return file;
}

/** Metadata-free, orientation-applied, bounded preview for admin viewing and AI providers (never the raw original). */
export async function previewOriginalSource(root: string, storageKey: string, maxSide = 2048) {
  const file = await containedRegularFile(root, storageKey);
  return sharp(file, { failOn: "error" }).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
}

/** Removes crash leftovers older than graceMs; only names matching the experimental partial shape are touched. */
export async function sweepPartials(root: string, graceMs: number, now = Date.now()) {
  const removed: string[] = [];
  for (const name of await readdir(root)) {
    if (!ORIGINAL_SOURCE_PARTIAL_RE.test(name)) continue;
    const info = await lstat(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || now - info.mtimeMs < graceMs) continue;
    await unlink(path.join(root, name));
    removed.push(name);
  }
  return removed;
}

interface StorageLike {
  saveIntakePhoto: (file: any) => Promise<{ storageKey: string }>;
  saveStagedIntakePhoto: (file: any) => Promise<{ storageKey: string }>;
  readIntakePhoto: (storageKey: string) => Promise<Buffer>;
}

/**
 * Installs the experiment on one in-process storage instance (offline probe only) and returns a restore function.
 * The disk-ingress guards mirror LocalAiIntakePhotoStorage.saveStagedIntakePhoto; admission is the live gate.
 */
export function installOriginalSourceStaging(storage: StorageLike, root: string, admission: { run: <T>(work: () => Promise<T>) => Promise<T>; aborted: () => Error; rejected: (reason: string) => Error }) {
  const saved = { saveIntakePhoto: storage.saveIntakePhoto, saveStagedIntakePhoto: storage.saveStagedIntakePhoto, readIntakePhoto: storage.readIntakePhoto };
  const clientError = (error: unknown) => error instanceof OriginalSourceRejected ? admission.rejected(error.reason) : error;
  storage.saveIntakePhoto = (file) => admission.run(async () => ({ storageKey: (await stageOriginalSource(root, file)).storageKey })).catch((error) => { throw clientError(error); });
  storage.saveStagedIntakePhoto = (file) => admission.run(async () => {
    if (file.signal.aborted) throw admission.aborted();
    sharp.cache({ files: 0 });
    const info = await lstat(file.path);
    if (path.dirname(file.path) !== file.workDir || path.basename(file.path) !== "input" || info.isSymbolicLink() || !info.isFile() || await realpath(file.path) !== path.resolve(file.path) || info.size !== file.size) {
      throw new OriginalSourceRejected("invalid-ingress");
    }
    const staged = await stageOriginalSource(root, { path: file.path, mimetype: file.mimetype, size: file.size });
    if (file.signal.aborted) { await rm(path.join(root, staged.storageKey), { force: true }); throw admission.aborted(); }
    return { storageKey: staged.storageKey };
  }).catch((error) => { throw clientError(error); });
  storage.readIntakePhoto = (storageKey) => admission.run(() => previewOriginalSource(root, storageKey));
  return () => Object.assign(storage, saved);
}
