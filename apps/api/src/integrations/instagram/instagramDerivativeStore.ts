/**
 * P5 (#472 parity 4B, option B): the protected-mode Instagram derivative store.
 *
 * - Store root `dirname(PRODUCT_PHOTO_DIR)/instagram-derivatives` holds only complete, content-addressed JPEGs. It is
 *   served solely by the registered, hash-verified route (routes/instagramDerivativeAssets.ts); it is never listed.
 * - Private job root `dirname(PRODUCT_PHOTO_DIR)/.instagram-derivative-jobs` (0700) holds confined-render job dirs and
 *   publication temporaries. It is never served. Only it is ever cleaned (own temporaries/job dirs).
 * - Before any protected-mode write both roots are asserted: real directories (no symlink), on one filesystem (link()),
 *   and not overlapping (equal, ancestor or descendant) with the canonical, private-operation, publication or AI-intake
 *   roots, or with each other.
 * - Publication: tmp (wx, 0600) -> fsync -> link() no-clobber -> fsync store dir -> verify published hash. An existing
 *   name is adopted only if its bytes hash-equal the new bytes; otherwise INSTAGRAM_STORE_KEY_CONFLICT (never overwrite,
 *   never delete). Nothing here writes, deletes or renames under the canonical, private-operation or publication roots.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { productPhotoStaticRoot } from "../../services/photoStorage";
import { photoOperationPrivateRoot } from "../../services/photoOperationAuthority";
import { photoPublicationStagingRoot } from "../../services/photoPublicationExecutor";
import { productPhotoStorageSafety } from "../../services/productPhotoStorageWorkflow";
import { InstagramClientError } from "./types";

export const INSTAGRAM_DERIVATIVE_STATIC_PATH = "/images/instagram-derivatives";
export const INSTAGRAM_DERIVATIVE_NAME = /^instagram-(v1|portrait-v1)-[0-9a-f]{64}\.jpg$/;
export const MAX_INSTAGRAM_DERIVATIVE_BYTES = 8 * 1024 * 1024;
export const instagramDerivativeRoot = (canonicalRoot: string = productPhotoStaticRoot) => path.join(path.dirname(path.resolve(canonicalRoot)), "instagram-derivatives");
export const instagramDerivativeJobRoot = (canonicalRoot: string = productPhotoStaticRoot) => path.join(path.dirname(path.resolve(canonicalRoot)), ".instagram-derivative-jobs");

export type InstagramStoreCode = "INSTAGRAM_STORE_UNSAFE" | "INSTAGRAM_STORE_KEY_CONFLICT" | "INSTAGRAM_STORE_BLOCKED";
/** Not retryable `processing`: an operator must resolve it. The caller contract (kind, retryable) is unchanged. */
export class InstagramStoreError extends InstagramClientError {
  constructor(readonly code: InstagramStoreCode) { super("processing", false); }
}
/** Structured, path-free operator log line for a refusal. */
function refuse(code: InstagramStoreCode, detail: Record<string, string> = {}): InstagramStoreError {
  console.warn(JSON.stringify({ event: "instagram_derivative_store_refused", code, ...detail }));
  return new InstagramStoreError(code);
}

const BLOCKING_ERRNO = new Set(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "EIO"]);
export const isBlockingStorageError = (error: unknown) => BLOCKING_ERRNO.has(String((error as any)?.code ?? ""));
export const storeBlocked = (error: unknown) => refuse("INSTAGRAM_STORE_BLOCKED", { errno: String((error as any)?.code ?? "") });

export interface InstagramStoreRoots { store: string; jobs: string }

const compare = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
function overlaps(a: string, b: string) {
  const x = compare(path.resolve(a)), y = compare(path.resolve(b));
  return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep);
}
async function resolved(dir: string) {
  try { return await realpath(dir); } catch (error: any) { if (error?.code === "ENOENT") return path.resolve(dir); throw error; }
}
/** Every protected root the store and job root must never overlap. */
export function protectedRoots(canonicalRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [canonicalRoot, photoOperationPrivateRoot(canonicalRoot), photoPublicationStagingRoot(canonicalRoot),
    env.AI_INTAKE_PHOTO_DIR ?? path.resolve(process.cwd(), "uploads/ai-intake-photos-private")];
}

/** Asserts (and creates, 0700) both roots before any protected-mode write. Refusal: INSTAGRAM_STORE_UNSAFE. */
export async function assertInstagramStoreSafe(canonicalRoot: string = productPhotoStaticRoot, env: NodeJS.ProcessEnv = process.env): Promise<InstagramStoreRoots> {
  const roots = { store: instagramDerivativeRoot(canonicalRoot), jobs: instagramDerivativeJobRoot(canonicalRoot) };
  const guarded = protectedRoots(canonicalRoot, env);
  const unsafe = (a: string, b: string[]) => b.some((p) => overlaps(a, p));
  if (unsafe(roots.store, [...guarded, roots.jobs]) || unsafe(roots.jobs, guarded)) throw refuse("INSTAGRAM_STORE_UNSAFE", { reason: "overlap" });
  for (const dir of [roots.store, roots.jobs]) {
    try { await mkdir(dir, { mode: 0o700 }); } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refuse("INSTAGRAM_STORE_UNSAFE", { reason: "not-a-directory" });
  }
  const [store, jobs] = [await realpath(roots.store), await realpath(roots.jobs)];
  const real = await Promise.all(guarded.map(resolved));
  if (unsafe(store, [...real, jobs]) || unsafe(jobs, real)) throw refuse("INSTAGRAM_STORE_UNSAFE", { reason: "overlap" });
  if ((await lstat(store)).dev !== (await lstat(jobs)).dev) throw refuse("INSTAGRAM_STORE_UNSAFE", { reason: "device" });
  return { store, jobs };
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Reads a regular, non-symlink file directly inside `root` by its validated inode (never reopened by path). */
export async function readStoreFile(root: string, name: string): Promise<Buffer> {
  const file = productPhotoStorageSafety.safeJoin(root, name);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INSTAGRAM_DERIVATIVE_BYTES || path.dirname(await realpath(file)) !== await realpath(root))
    throw Object.assign(new Error("Not a stored derivative"), { code: "ENOENT" });
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_INSTAGRAM_DERIVATIVE_BYTES)
      throw Object.assign(new Error("Not a stored derivative"), { code: "ENOENT" });
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Directory fsync makes the new name durable on Linux; Windows cannot open directories for fsync (dev only). */
async function fsyncDirectory(dir: string) {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export type StorePhase = "tmp-fsynced" | "linked" | "adopted" | "dir-fsynced" | "verified";
/** Publishes `bytes` as `name` in the store; returns their sha256. `hook` is a test seam for ordering/crash points. */
export async function publishToInstagramStore(bytes: Buffer, name: string, roots: InstagramStoreRoots,
  hook: (phase: StorePhase) => void | Promise<void> = () => {}): Promise<string> {
  if (!INSTAGRAM_DERIVATIVE_NAME.test(name)) throw refuse("INSTAGRAM_STORE_UNSAFE", { reason: "name" });
  const digest = sha256(bytes);
  const destination = productPhotoStorageSafety.safeJoin(roots.store, name);
  const temporary = productPhotoStorageSafety.safeJoin(roots.jobs, `.instagram-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await hook("tmp-fsynced");
    try { await link(temporary, destination); await hook("linked"); }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (sha256(await readStoreFile(roots.store, name)) !== digest) throw refuse("INSTAGRAM_STORE_KEY_CONFLICT");
      await hook("adopted");
    }
    await fsyncDirectory(roots.store);
    await hook("dir-fsynced");
    if (sha256(await readStoreFile(roots.store, name)) !== digest) throw refuse("INSTAGRAM_STORE_KEY_CONFLICT");
    await hook("verified");
    return digest;
  } finally { await unlink(temporary).catch(() => undefined); } // job root only; the published name stays
}
