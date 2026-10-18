/**
 * #472 F2 Step 3 OFFLINE TEST-ONLY copy-owned publisher. Never imported by runtime code.
 *
 * Publishes a SEALED worker source by copying its bytes into a PUBLISHER-OWNED staging inode (in a directory no
 * worker may write), verifying the copy against the seal through the publisher's own descriptor, durably recording
 * the staging inode identity, and only then linking that inode to the canonical name (never replace). The worker's
 * source inode is never linked, so worker hardlink aliases and retained source descriptors cannot reach published bytes.
 *
 * Snapshot integrity  : the staged copy equals the seal (sha256 + size) AND the source is the sealed inode (dev, ino).
 * Byte immutability   : after publication no worker holds a write path to the published inode. That relies on the
 *                       Step 2 confinement of every worker (Landlock, fd closure) — not on chmod, pathname checks,
 *                       process exit, or a single unchanged hash.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Seal { sha256: string; size: number; dev: string; ino: string }
export interface PublishTarget { source: string; seal: Seal; canonicalDir: string; canonicalName: string; stagingRoot: string; operationId: string; generation: number; chunkSize?: number }
export type Phase = "source-opened" | "staging-created" | "copy-partial" | "copied" | "verified" | "manifest-written" | "linked" | "cleaned";
export type Hook = (phase: Phase, detail: Record<string, unknown>) => void | Promise<void>;
export type Outcome =
  | { kind: "PUBLISHED" | "ADOPTED"; dev: string; ino: string }
  | { kind: "SOURCE_REPLACED" | "SNAPSHOT_MISMATCH" | "COLLISION" | "SOURCE_MISSING"; detail?: string };

const identity = (st: fs.BigIntStats) => ({ dev: String(st.dev), ino: String(st.ino) });

/** Trusted sealing read (the worker is held at a barrier while this runs). */
export function sealSource(file: string): Seal {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    return { sha256: hashFd(fd, Number(st.size)).sha256, size: Number(st.size), ...identity(st) };
  } finally { fs.closeSync(fd); }
}

function hashFd(fd: number, size: number) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let position = 0, total = 0;
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n)); position += n; total += n;
  }
  return { sha256: hash.digest("hex"), bytes: total, expected: size };
}

export function stagingDir(t: PublishTarget) { return path.join(t.stagingRoot, t.operationId, String(t.generation)); }
const manifestPath = (t: PublishTarget) => path.join(stagingDir(t), "manifest.json");
function fsyncDir(dir: string) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function readManifest(t: PublishTarget): { dev: string; ino: string; sha256: string } | null {
  try { return JSON.parse(fs.readFileSync(manifestPath(t), "utf8")); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
}
/** Cleanup ownership: only data-* names inside this operation's own staging namespace. Never canonical or source. */
function removeOwnStagingData(t: PublishTarget) {
  const dir = stagingDir(t);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
  for (const name of names) if (/^data-[0-9a-f]{16}$/.test(name)) fs.unlinkSync(path.join(dir, name));
}

/** Retry-safe: an existing canonical name is adopted only if it is exactly the inode this publisher recorded. */
function resolveExisting(t: PublishTarget, canonical: string): Outcome {
  const manifest = readManifest(t);
  const st = fs.lstatSync(canonical, { bigint: true });
  if (manifest && st.isFile() && String(st.dev) === manifest.dev && String(st.ino) === manifest.ino) {
    const fd = fs.openSync(canonical, "r");
    try { if (hashFd(fd, t.seal.size).sha256 === t.seal.sha256 && manifest.sha256 === t.seal.sha256) { removeOwnStagingData(t); return { kind: "ADOPTED", ...identity(st) }; } }
    finally { fs.closeSync(fd); }
  }
  removeOwnStagingData(t); // our own unlinked copy only; the foreign canonical file is never touched
  return { kind: "COLLISION", detail: "canonical name exists and is not this publisher's recorded inode" };
}

export async function publish(t: PublishTarget, hook: Hook = () => {}): Promise<Outcome> {
  const canonical = path.join(t.canonicalDir, t.canonicalName);
  if (fs.existsSync(canonical)) return resolveExisting(t, canonical);
  removeOwnStagingData(t); // incomplete or unlinked copies from a crashed attempt are never reused
  let source: number;
  try { source = fs.openSync(t.source, "r"); } catch (e: any) { return { kind: "SOURCE_MISSING", detail: e?.code }; }
  let staged = -1, stagedName = "";
  try {
    const st = fs.fstatSync(source, { bigint: true });
    if (String(st.dev) !== t.seal.dev || String(st.ino) !== t.seal.ino) return { kind: "SOURCE_REPLACED" };
    await hook("source-opened", {});
    const dir = stagingDir(t);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    stagedName = path.join(dir, "data-" + randomBytes(8).toString("hex"));
    // O_RDWR|O_CREAT|O_EXCL: a fresh publisher-owned inode, readable back through the same descriptor for verification.
    staged = fs.openSync(stagedName, "wx+", 0o600);
    await hook("staging-created", { pid: process.pid, fd: staged });
    const chunk = Buffer.alloc(t.chunkSize ?? 64 * 1024);
    let position = 0, first = true;
    for (;;) {
      const n = fs.readSync(source, chunk, 0, chunk.length, position);
      if (n === 0) break;
      fs.writeSync(staged, chunk, 0, n, position);
      position += n;
      if (first) { first = false; await hook("copy-partial", { pid: process.pid, fd: staged, copied: position }); }
    }
    fs.fsyncSync(staged);
    await hook("copied", { pid: process.pid, fd: staged });
    // Integrity is decided on the PUBLISHER's copy, read back through the publisher's own descriptor.
    const verified = hashFd(staged, t.seal.size);
    if (verified.sha256 !== t.seal.sha256 || verified.bytes !== t.seal.size) {
      fs.closeSync(staged); staged = -1; removeOwnStagingData(t);
      return { kind: "SNAPSHOT_MISMATCH" };
    }
    const stagedIdentity = identity(fs.fstatSync(staged, { bigint: true }));
    fs.closeSync(staged); staged = -1; // the publisher retains no write descriptor after verification
    await hook("verified", stagedIdentity);
    const tmp = manifestPath(t) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ...stagedIdentity, sha256: t.seal.sha256, operationId: t.operationId, generation: t.generation }));
    const mfd = fs.openSync(tmp, "r+"); fs.fsyncSync(mfd); fs.closeSync(mfd);
    fs.renameSync(tmp, manifestPath(t)); fsyncDir(dir);
    await hook("manifest-written", stagedIdentity);
    try { fs.linkSync(stagedName, canonical); } // never replaces an existing name
    catch (e: any) { if (e?.code === "EEXIST") return resolveExisting(t, canonical); throw e; }
    fsyncDir(t.canonicalDir);
    await hook("linked", stagedIdentity);
    removeOwnStagingData(t); fsyncDir(dir);
    await hook("cleaned", stagedIdentity);
    return { kind: "PUBLISHED", ...stagedIdentity };
  } finally {
    if (staged >= 0) fs.closeSync(staged);
    fs.closeSync(source);
  }
}

/** NEGATIVE CONTROL ONLY: the rejected design that links the worker's own inode (the 470 LIMIT shape). */
export function publishByLinkingWorkerInode(t: PublishTarget) {
  fs.linkSync(t.source, path.join(t.canonicalDir, t.canonicalName));
}
