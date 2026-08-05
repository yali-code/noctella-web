import { opendir, lstat, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Sprint 96: the one shared filesystem adapter for every automatic-deletion
 * candidate this sprint introduces (the private AI-intake staged-photo
 * orphan sweep, the canonical ProductPhoto orphan sweep, and the hardened
 * LocalAiIntakePhotoStorage.deleteIntakePhoto). Owns exactly: path
 * containment, lstat-based classification (never stat - a symlink must never
 * be silently followed), and regular-file-only deletion. Knows nothing about
 * AI intake photos, ProductPhotos, retention, or any other domain concept -
 * every candidate is identified purely by a caller-supplied storage root and
 * a single filename/key.
 */

export type ManagedFileDisposition = "regular_file" | "already_absent" | "unsafe_path" | "symlink" | "directory" | "other_non_regular";

/**
 * Rejects anything that is not a single, safe, contained path segment -
 * empty, a NUL byte, "..", a forward or back slash, an absolute path (POSIX
 * or Windows form, checked with both platform parsers regardless of the host
 * OS this process happens to run on), or a key whose basename does not equal
 * itself (i.e. anything that isn't already a bare filename). Returns the
 * resolved absolute path only when every check passes.
 */
function resolveContainedPath(root: string, key: string): string | null {
  if (!key || key.length === 0) return null;
  if (key.includes("\0")) return null;
  if (key.includes("..")) return null;
  if (key.includes("/") || key.includes("\\")) return null;
  if (path.posix.isAbsolute(key) || path.win32.isAbsolute(key)) return null;
  if (path.basename(key) !== key) return null;

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, key);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) return null;
  return candidate;
}

/**
 * Classifies a candidate file without ever deleting it - callers use this to
 * decide eligibility (age checks, DB ownership checks, etc.) before ever
 * calling deleteManagedFile. Always uses lstat, never stat, so a symlink is
 * classified as "symlink" (and its target is never inspected or followed).
 */
export async function statManagedFile(root: string, key: string): Promise<{ disposition: ManagedFileDisposition; mtimeMs?: number; path?: string }> {
  const candidate = resolveContainedPath(root, key);
  if (!candidate) return { disposition: "unsafe_path" };
  let stat;
  try {
    stat = await lstat(candidate);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { disposition: "already_absent" };
    throw err;
  }
  if (stat.isSymbolicLink()) return { disposition: "symlink" };
  if (!stat.isFile()) return { disposition: "directory" };
  return { disposition: "regular_file", mtimeMs: stat.mtimeMs, path: candidate };
}

/**
 * Deletes exactly one confirmed regular, non-symlink, contained file.
 * Idempotent (an already-absent file is a success, not a failure). Never
 * uses recursive deletion, and never deletes anything this function did not
 * itself just lstat-confirm as a regular file - re-validates rather than
 * trusting a disposition computed by an earlier, separate statManagedFile
 * call, since filesystem state can change between the two.
 */
export async function deleteManagedFile(root: string, key: string): Promise<ManagedFileDisposition> {
  const info = await statManagedFile(root, key);
  if (info.disposition !== "regular_file") return info.disposition;
  try {
    await unlink(info.path!);
  } catch (err: any) {
    if (err?.code === "ENOENT") return "already_absent";
    throw err;
  }
  return "regular_file";
}

export interface ManagedDirectoryEntry {
  name: string;
  disposition: ManagedFileDisposition;
  mtimeMs?: number;
}

export interface ManagedDirectoryWalkOptions {
  maxExamine: number;
  timeBudgetMs: number;
  now(): number;
}

export interface ManagedDirectoryWalkResult {
  entries: ManagedDirectoryEntry[];
  truncated: boolean;
}

/**
 * Streams a managed storage root via fs.opendir - never materializes the
 * full directory listing in memory (readdir()-then-slice is deliberately not
 * used here). Always walks from the beginning of the directory on every
 * call - no cursor is stored or accepted, so no entry is ever permanently
 * unreachable due to iteration position; fairness across runs comes from
 * doing a full pass every time, not from remembering where a previous pass
 * stopped. Stops early (truncated:true) only if the examined-entry ceiling
 * or the time budget is reached before the directory is fully walked.
 */
export async function walkManagedDirectory(root: string, options: ManagedDirectoryWalkOptions): Promise<ManagedDirectoryWalkResult> {
  const entries: ManagedDirectoryEntry[] = [];
  const startedAt = options.now();
  let dir;
  try {
    dir = await opendir(root);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { entries, truncated: false };
    throw err;
  }
  let truncated = false;
  // fs.Dir's async iterator closes the underlying handle itself - on normal completion, on an
  // early `break`, and on an exception thrown from the loop body (via its `return()` method,
  // matching for-await-of's built-in iterator-cleanup semantics) - so no explicit dir.close() is
  // needed or safe to add here: calling it again after the iterator already closed the handle
  // throws "Directory handle was closed".
  for await (const dirent of dir) {
    if (entries.length >= options.maxExamine) { truncated = true; break; }
    if (options.now() - startedAt >= options.timeBudgetMs) { truncated = true; break; }
    const info = await statManagedFile(root, dirent.name);
    entries.push({ name: dirent.name, disposition: info.disposition, mtimeMs: info.mtimeMs });
  }
  return { entries, truncated };
}
