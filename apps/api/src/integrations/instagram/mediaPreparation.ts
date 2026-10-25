import { runImageOperation, PhotoUploadError } from "../../services/photoUploadAdmission";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { productPhotoStaticPath, productPhotoStaticRoot, PRODUCT_PHOTO_MAX_BYTES } from "../../services/photoStorage";
import { productPhotoStorageSafety } from "../../services/productPhotoStorageWorkflow";
import { validateInstagramMediaUrl } from "../../config/instagramConfig";
import { InstagramClientError } from "./types";
import { imageRecipes, renderInstagramDerivative, type InstagramImageRecipe } from "./instagramDerivativeRecipe";
import { photoOwnershipFencingEnabled } from "../../services/photoOwnershipFencing";
import { assertPreparationConfinementReady, photoPreparationConfinementConfig, renderDerivativeInConfinedWorker } from "../../services/photoPreparationConfinement";
import {
  INSTAGRAM_DERIVATIVE_STATIC_PATH, assertInstagramStoreSafe, instagramDerivativeRoot, InstagramStoreError,
  isBlockingStorageError, publishToInstagramStore, readStoreFile, sha256, storeBlocked,
} from "./instagramDerivativeStore";

/**
 * #472 daily-use parity 4B. In protected mode (fencing ON) Instagram derivatives are NOT written into the canonical
 * product-photo root: they go to this separate, NON-canonical, content-addressed store (a sibling of the canonical
 * root on the same disk, served at INSTAGRAM_DERIVATIVE_STATIC_PATH). The canonical root is only read. Rendering runs
 * in the mandatory confined worker (unprotected in-process only for test/development), from a private copy of the
 * verified source bytes. Lifecycle: derivatives are immutable, regenerable and referenced by
 * social_prepared_images.output_path; they are never overwritten (no-clobber link) and nothing here deletes them.
 * W11/0042 stays dormant. With fencing OFF the original canonical-root behaviour is unchanged.
 * P5: the store, its private job root, publication and serving live in instagramDerivativeStore.ts and
 * routes/instagramDerivativeAssets.ts; protected-mode records carry output_sha256 and are trusted only on an exact match.
 */
export { INSTAGRAM_DERIVATIVE_STATIC_PATH, instagramDerivativeRoot };
/** The store an already prepared outputPath lives in (canonical root for records prepared before protected mode). */
function storeOf(outputPath: string, canonicalRoot: string) {
  return outputPath.startsWith(`${INSTAGRAM_DERIVATIVE_STATIC_PATH}/`)
    ? { root: instagramDerivativeRoot(canonicalRoot), prefix: INSTAGRAM_DERIVATIVE_STATIC_PATH }
    : { root: canonicalRoot, prefix: productPhotoStaticPath };
}

const inFlight = new Map<string, Promise<string | void>>();
export const INSTAGRAM_IMAGE_RECIPE = "instagram-v1";
export { renderInstagramDerivative, type InstagramImageRecipe };
export interface PreparedInstagramImage {
  url: string;
  outputPath: string;
  sourceFingerprint: string;
  recipeVersion: string;
  /** Protected mode only: sha256 of the published store file (social_prepared_images.output_sha256). */
  outputSha256?: string | null;
}
const invalid = () => new InstagramClientError("invalid_media", false);
function canonicalFilename(url: string): string {
  const prefix = `${productPhotoStaticPath}/`;
  if (typeof url !== "string" || !url.startsWith(prefix)) throw invalid();
  const filename = url.slice(prefix.length);
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.webp$/.test(filename) || filename.includes("..")) throw invalid();
  return filename;
}
export const sourceFingerprint = (filename: string, source: Buffer) => createHash("sha256").update(filename).update("\0").update(source).digest("hex");

async function readRegularLocalFile(root: string, filename: string): Promise<Buffer> {
  const file = productPhotoStorageSafety.safeJoin(root, filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > PRODUCT_PHOTO_MAX_BYTES ||
      path.dirname(await realpath(file)) !== await realpath(root)) throw invalid();
  // Read the validated inode, never reopen the pathname after checking it. O_NOFOLLOW
  // blocks final-component symlinks on POSIX; inode/path checks also cover Windows.
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(file);
    if (!opened.isFile() || opened.size > PRODUCT_PHOTO_MAX_BYTES || current.isSymbolicLink() ||
        opened.dev !== info.dev || opened.ino !== info.ino ||
        current.dev !== opened.dev || current.ino !== opened.ino ||
        path.dirname(await realpath(file)) !== await realpath(root)) throw invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > PRODUCT_PHOTO_MAX_BYTES || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw invalid();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function validDerivative(root: string, filename: string, recipe: typeof imageRecipes[InstagramImageRecipe]): Promise<boolean> {
  try {
    const bytes = await readRegularLocalFile(root, filename);
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    if (bytes.length > 8 * 1024 * 1024 || metadata.format !== "jpeg" || metadata.width !== recipe.width || metadata.height !== recipe.height) throw invalid();
    await sharp(bytes, { failOn: "error" }).raw().toBuffer();
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Local-only derivative; no ProductPhoto writes, HTTP reads, or credential handling. */
async function inspectPreparedInstagramImageUnadmitted(
  photo: { url: string },
  prepared: Pick<PreparedInstagramImage, "sourceFingerprint" | "recipeVersion" | "outputPath" | "outputSha256">,
  root: string = productPhotoStaticRoot,
): Promise<boolean> {
  try {
    if (!Object.prototype.hasOwnProperty.call(imageRecipes, prepared.recipeVersion)) return false;
    const recipe = imageRecipes[prepared.recipeVersion as InstagramImageRecipe];
    const filename = canonicalFilename(photo.url);
    const source = await readRegularLocalFile(root, filename);
    const fingerprint = sourceFingerprint(filename, source);
    if (fingerprint !== prepared.sourceFingerprint) return false;
    const derivative = `${prepared.recipeVersion}-${fingerprint}.jpg`;
    const store = storeOf(prepared.outputPath, root);
    if (prepared.outputPath !== `${store.prefix}/${derivative}`) return false;
    // P5: protected mode trusts only a store record whose recorded output_sha256 exactly matches the stored bytes. A NULL
    // hash or a legacy canonical record is never current here (re-preparation goes to the store; nothing is modified).
    if (photoOwnershipFencingEnabled()) {
      if (typeof prepared.outputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(prepared.outputSha256) || store.root !== instagramDerivativeRoot(root)) return false;
      return sha256(await readStoreFile(store.root, derivative)) === prepared.outputSha256;
    }
    return await validDerivative(store.root, derivative, recipe);
  } catch (error: any) {
    // Missing/unsafe/undecodable assets are invalid. Other OS failures are infrastructure errors.
    if (error?.code && !["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) {
      throw new Error("Prepared image inspection failed");
    }
    return false;
  }
}

export async function prepareInstagramImage(
  photo: { url: string },
  publicOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
  root: string = productPhotoStaticRoot,
): Promise<string> {
  return (await prepareInstagramImageAsset(photo, publicOrigin, env, root)).url;
}

async function prepareInstagramImageAssetUnadmitted(
  photo: { url: string },
  publicOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
  root: string = productPhotoStaticRoot,
  recipeId: InstagramImageRecipe = INSTAGRAM_IMAGE_RECIPE,
): Promise<PreparedInstagramImage> {
  const protectedMode = photoOwnershipFencingEnabled();
  // Protected mode requires confined preparation; a missing prerequisite is a retryable refusal, never a fallback.
  if (protectedMode) { try { assertPreparationConfinementReady(); } catch { throw new InstagramClientError("processing", true); } }
  try {
    if (typeof recipeId !== "string" || !Object.prototype.hasOwnProperty.call(imageRecipes, recipeId)) throw invalid();
    const recipe = imageRecipes[recipeId];
    const prefix = `${productPhotoStaticPath}/`;
    const filename = canonicalFilename(photo.url);
    const origin = new URL(publicOrigin);
    if (publicOrigin !== origin.origin) throw invalid();
    validateInstagramMediaUrl(`${origin.origin}${photo.url}`, env);
    const source = await readRegularLocalFile(root, filename);
    if (source.length > PRODUCT_PHOTO_MAX_BYTES) throw invalid();
    // Version + source identity/content prevent stale reuse if a canonical file changes.
    const hash = sourceFingerprint(filename, source);
    const derivative = `${recipeId}-${hash}.jpg`;
    const store = protectedMode ? { root: instagramDerivativeRoot(root), prefix: `${INSTAGRAM_DERIVATIVE_STATIC_PATH}/` } : { root, prefix };
    // P5: both store roots are asserted (real dirs, one filesystem, no overlap with any protected root) before any write.
    const roots = protectedMode ? await assertInstagramStoreSafe(root) : null;
    const destination = productPhotoStorageSafety.safeJoin(store.root, derivative);
    const url = validateInstagramMediaUrl(`${origin.origin}${store.prefix}${derivative}`, env);
    let work = inFlight.get(destination);
    if (!work && roots) {
      // Always render (deterministic recipe), then publish no-clobber: an existing name is adopted only on equal hash.
      work = (async () => publishToInstagramStore(await renderProtected(source, recipeId, roots.jobs), derivative, roots))();
      inFlight.set(destination, work);
    }
    if (!work) {
      work = (async () => {
        if (await validDerivative(store.root, derivative, recipe)) return;
        const bytes = protectedMode ? await renderProtected(source, recipeId, store.root) : await renderInstagramDerivative(source, recipeId);
        const temporary = productPhotoStorageSafety.safeJoin(store.root, `.instagram-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: "wx" });
          // Atomic, no-clobber publication: readers never see an incomplete JPEG.
          try { await link(temporary, destination); }
          catch (error: any) {
            if (error?.code !== "EEXIST" || !await validDerivative(store.root, derivative, recipe)) throw error;
          }
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      })();
      inFlight.set(destination, work);
    }
    let published: string | void;
    try { published = await work; }
    finally { if (inFlight.get(destination) === work) inFlight.delete(destination); }
    return { url, outputPath: `${store.prefix}${derivative}`, sourceFingerprint: hash, recipeVersion: recipeId, ...(protectedMode ? { outputSha256: published as string } : {}) };
  } catch (error) {
    if (protectedMode) throw classifyProtectedFailure(error);
    // Confined-worker unavailability (start failure, no Landlock enforcement, timeout) is infrastructure, not bad media:
    // retryable, like the pre-check refusal. Never surface Sharp/filesystem errors, paths, or supplied URL credentials.
    if (error instanceof PhotoUploadError && error.status === 503) throw new InstagramClientError("processing", true);
    throw invalid();
  }
}

/**
 * Protected-mode rendering: the confined worker gets a private copy of the verified source bytes (no path re-read), in a
 * job directory under the private, never-served job root (P5), and may write only that directory.
 */
async function renderProtected(source: Buffer, recipeId: InstagramImageRecipe, jobRoot: string): Promise<Buffer> {
  const config = photoPreparationConfinementConfig();
  if (config.mode !== "confined") return renderInstagramDerivative(source, recipeId); // test/development only (unprotected)
  const jobDir = path.join(jobRoot, `.job-${randomUUID()}`);
  await mkdir(jobDir, { mode: 0o700 });
  try {
    const input = path.join(jobDir, "source.webp");
    await writeFile(input, source, { flag: "wx", mode: 0o600 });
    const { bytes } = await renderDerivativeInConfinedWorker(config.launcher, { kind: "instagram", inputPath: input, recipe: recipeId, outDir: jobDir }, jobDir);
    return bytes;
  } finally { await rm(jobDir, { recursive: true, force: true }); }
}

/**
 * P5 protected-mode classification (the caller contract keeps the existing kinds):
 * - store unsafe / key conflict: InstagramStoreError as raised (processing, not retryable);
 * - ENOSPC/EDQUOT/EACCES/EPERM/EROFS/EIO, in the parent or reported by the worker: INSTAGRAM_STORE_BLOCKED (not retryable);
 * - confined-worker start failure, timeout or missing enforcement (503): processing, retryable;
 * - media/format and anything else: invalid_media, not retryable. Never surfaces paths, Sharp text or URL credentials.
 */
export function classifyProtectedFailure(error: unknown): InstagramClientError {
  if (error instanceof InstagramStoreError) return error;
  if (isBlockingStorageError(error)) return storeBlocked(error);
  if (error instanceof PhotoUploadError && error.status === 503) return new InstagramClientError("processing", true);
  return invalid();
}

async function instagramImageOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await runImageOperation(work); }
  catch (error) {
    // Capacity is infrastructure pressure, not a permanent invalid-media error.
    if (error instanceof PhotoUploadError) throw new InstagramClientError("processing", true);
    throw error;
  }
}
export const inspectPreparedInstagramImage: typeof inspectPreparedInstagramImageUnadmitted =
  (...args) => instagramImageOperation(() => inspectPreparedInstagramImageUnadmitted(...args));
export const prepareInstagramImageAsset: typeof prepareInstagramImageAssetUnadmitted =
  (...args) => instagramImageOperation(() => prepareInstagramImageAssetUnadmitted(...args));
