import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { productPhotoStaticPath, productPhotoStaticRoot, PRODUCT_PHOTO_MAX_BYTES } from "../../services/photoStorage";
import { productPhotoStorageSafety } from "../../services/productPhotoStorageWorkflow";
import { validateInstagramMediaUrl } from "../../config/instagramConfig";
import { InstagramClientError } from "./types";

const inFlight = new Map<string, Promise<void>>();
const invalid = () => new InstagramClientError("invalid_media", false);

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

async function validDerivative(root: string, filename: string): Promise<boolean> {
  try {
    const bytes = await readRegularLocalFile(root, filename);
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    if (bytes.length > 8 * 1024 * 1024 || metadata.format !== "jpeg" || metadata.width !== 1080 || metadata.height !== 1080) throw invalid();
    await sharp(bytes, { failOn: "error" }).raw().toBuffer();
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Local-only derivative; no ProductPhoto writes, HTTP reads, or credential handling. */
export async function prepareInstagramImage(
  photo: { url: string },
  publicOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
  root: string = productPhotoStaticRoot,
): Promise<string> {
  try {
    const prefix = `${productPhotoStaticPath}/`;
    if (typeof photo.url !== "string" || !photo.url.startsWith(prefix)) throw invalid();
    const filename = photo.url.slice(prefix.length);
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.webp$/.test(filename) || filename.includes("..")) throw invalid();
    const origin = new URL(publicOrigin);
    if (publicOrigin !== origin.origin) throw invalid();
    validateInstagramMediaUrl(`${origin.origin}${photo.url}`, env);
    const source = await readRegularLocalFile(root, filename);
    if (source.length > PRODUCT_PHOTO_MAX_BYTES) throw invalid();
    // Version + source identity/content prevent stale reuse if a canonical file changes.
    const hash = createHash("sha256").update(filename).update("\0").update(source).digest("hex");
    const derivative = `instagram-v1-${hash}.jpg`;
    const destination = productPhotoStorageSafety.safeJoin(root, derivative);
    const url = validateInstagramMediaUrl(`${origin.origin}${prefix}${derivative}`, env);
    let work = inFlight.get(destination);
    if (!work) {
      work = (async () => {
        if (await validDerivative(root, derivative)) return;
        const image = sharp(source, { failOn: "error", limitInputPixels: 40_000_000 });
        const metadata = await image.metadata();
        if (metadata.format !== "webp" || (metadata.pages ?? 1) !== 1) throw invalid();
        // Contain preserves the entire image and its proportions, including extreme ratios.
        const bytes = await image.rotate().resize(1080, 1080, { fit: "contain", background: "#ffffff" })
          .flatten({ background: "#ffffff" }).toColourspace("srgb").jpeg({ quality: 90 }).toBuffer();
        if (bytes.length > 8 * 1024 * 1024) throw invalid();
        const temporary = productPhotoStorageSafety.safeJoin(root, `.instagram-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: "wx" });
          // Atomic, no-clobber publication: readers never see an incomplete JPEG.
          try { await link(temporary, destination); }
          catch (error: any) {
            if (error?.code !== "EEXIST" || !await validDerivative(root, derivative)) throw error;
          }
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      })();
      inFlight.set(destination, work);
    }
    try { await work; }
    finally { if (inFlight.get(destination) === work) inFlight.delete(destination); }
    return url;
  } catch {
    // Never surface Sharp/filesystem errors, paths, or supplied URL credentials.
    throw invalid();
  }
}
