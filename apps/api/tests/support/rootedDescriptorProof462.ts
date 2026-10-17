/** #462 TEST-ONLY prototype. No production import. See threat model before considering integration. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
export interface RootedProof { sha256: string; bytes: number; dev: string; ino: string }
interface Hooks { beforeOpen?: () => Promise<void>; afterRead?: () => Promise<void> }
const refuse = () => { throw new Error("AUDIT_FILE_PROOF_REFUSED"); };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stable = (a: BigIntStats, b: BigIntStats) => identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function ancestors(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) refuse();
  // root is a provisioned trust anchor; its parents/ACLs are deployment prerequisites, not traversed here.
  const dirs: Array<{ name: string; stat: BigIntStats }> = [];
  let current = root;
  const names = [root];
  const parent = path.dirname(relative);
  if (parent !== ".") for (const part of parent.split(path.sep)) { current = path.join(current, part); names.push(current); }
  for (const name of names) {
    const stat = await lstat(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(name), name)) refuse();
    dirs.push({ name, stat });
  }
  return dirs;
}
/** maxBytes is a hard bounded-read limit, not a post-read memory check. ACL trust is an external prerequisite. */
export async function rootedDescriptorProof(root: string, relative: string, maxBytes = 8 * 1024 * 1024, hooks: Hooks = {}): Promise<RootedProof> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !relative || relative.includes(":") || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === ".." || p === "")) refuse();
  root = path.resolve(root); const file = path.resolve(root, relative);
  const dirs = await ancestors(root, file), before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) refuse();
  await hooks.beforeOpen?.();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !stable(before, opened)) refuse();
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead; if (bytes > maxBytes) refuse(); hash.update(buffer.subarray(0, result.bytesRead));
    }
    await hooks.afterRead?.();
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (!stable(opened, after) || !stable(after, named) || !named.isFile() || named.isSymbolicLink() || BigInt(bytes) !== after.size) refuse();
    const post = await ancestors(root, file);
    if (post.length !== dirs.length || post.some((d, i) => !identity(d.stat, dirs[i].stat) || d.name !== dirs[i].name)) refuse();
    return { sha256: hash.digest("hex"), bytes, dev: String(after.dev), ino: String(after.ino) };
  } finally { await handle.close(); }
}
