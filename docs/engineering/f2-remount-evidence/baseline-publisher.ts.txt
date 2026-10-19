/**
 * Stage 5 F2 (#472) WP2: runtime copy-owned publisher (ported from the Step 3 offline proof).
 *
 * Publishes one SEALED artifact by copying its bytes into a PUBLISHER-OWNED staging inode, verifying the copy against
 * the seal through the publisher's own descriptor, durably recording the copy identity through the caller's fenced
 * ledger, and only then linking that inode to the canonical name (never replace). The sealed source inode is never
 * linked, so aliases of or descriptors to the source cannot reach published bytes.
 *
 * - Snapshot integrity: the source must still be the sealed inode (dev, ino) and the copy must equal the seal
 *   (sha256 + size), checked on the publisher's copy, never on the source.
 * - Recovery: an existing canonical name is adopted only when it is exactly the recorded copy inode and still holds the
 *   sealed bytes; anything else is a COLLISION and is never touched (no overwrite, no cleanup of foreign files).
 * - Anchor (runtime owners, `retainStagingLink`): the verified copy keeps its staging name as a second link until the
 *   operation commits. While that name exists the inode cannot be freed, so its number cannot be reused by a later file;
 *   adoption requires the canonical name and the staging anchor to be the same inode. The owner removes the staging
 *   namespace only after commit.
 * - Cleanup: only `data-*` names inside this artifact's own staging directory.
 * - Descriptors: every descriptor is closed before returning; none is retained after verification.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CopySeal { sha256: string; size: number; dev: string; ino: string }
/** birthNs: the inode birth time, an additional identity check (the staging anchor is the primary reuse guard). */
export interface CopyRecord { stagingName: string; dev: string; ino: string; birthNs: string; sha256: string; bytes: number }
/** The caller's durable, authority-fenced record of the copy (database). record() must throw if authority is lost. */
export interface CopyLedger { read(): Promise<CopyRecord | null>; record(copy: CopyRecord): Promise<void> }
export interface CopyTarget { source: string; seal: CopySeal; canonicalDir: string; canonicalName: string; stagingDir: string; chunkSize?: number; retainStagingLink?: boolean }
export type CopyPhase = "source-opened" | "staging-created" | "copy-partial" | "copied" | "verified" | "recorded" | "linked" | "cleaned";
/** `detail.fd` is the publisher's own staging descriptor while it is open (diagnostics and capability probes only). */
export type CopyHook = (phase: CopyPhase, detail?: { fd?: number }) => void | Promise<void>;
export type CopyOutcome =
  | { kind: "PUBLISHED" | "ADOPTED"; dev: string; ino: string }
  | { kind: "SOURCE_REPLACED" | "SNAPSHOT_MISMATCH" | "COLLISION" | "SOURCE_MISSING"; detail?: string };

const DATA_NAME = /^data-[0-9a-f]{16}$/;
const identity = (st: fs.BigIntStats) => ({ dev: String(st.dev), ino: String(st.ino), birthNs: String(st.birthtimeNs) });
const sameInode = (st: fs.BigIntStats, r: Pick<CopyRecord, "dev" | "ino" | "birthNs">) => String(st.dev) === r.dev && String(st.ino) === r.ino && String(st.birthtimeNs) === r.birthNs;

function hashFd(fd: number) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (n === 0) break;
    hash.update(buffer.subarray(0, n)); position += n;
  }
  return { sha256: hash.digest("hex"), bytes: position };
}
/** Directory fsync makes the new name durable on Linux; Windows cannot open directories for fsync (dev only). */
function fsyncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Cleanup ownership: only data-* names inside this artifact's own staging directory (except `keep`). Never canonical or source. */
export function removeOwnStagingData(stagingDir: string, keep?: string) {
  let names: string[] = [];
  try { names = fs.readdirSync(stagingDir); } catch (e: any) { if (e?.code === "ENOENT") return; throw e; }
  for (const name of names) if (DATA_NAME.test(name) && name !== keep) fs.rmSync(path.join(stagingDir, name), { force: true });
}

/** With an anchor, the publisher's own staging name must still be exactly the recorded (and canonical) inode. */
function anchored(t: CopyTarget, recorded: CopyRecord, st: fs.BigIntStats): boolean {
  if (!t.retainStagingLink) return true;
  if (!DATA_NAME.test(recorded.stagingName)) return false;
  try { const anchor = fs.lstatSync(path.join(t.stagingDir, recorded.stagingName), { bigint: true }); return anchor.isFile() && anchor.dev === st.dev && anchor.ino === st.ino; }
  catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}

async function resolveExisting(t: CopyTarget, ledger: CopyLedger, canonical: string): Promise<CopyOutcome> {
  const recorded = await ledger.read();
  const st = fs.lstatSync(canonical, { bigint: true });
  if (recorded && st.isFile() && sameInode(st, recorded) && recorded.sha256 === t.seal.sha256 && anchored(t, recorded, st)) {
    const fd = fs.openSync(canonical, "r");
    try {
      const fresh = fs.fstatSync(fd, { bigint: true });
      const current = hashFd(fd);
      if (sameInode(fresh, recorded) && current.sha256 === t.seal.sha256 && current.bytes === t.seal.size && anchored(t, recorded, fresh)) {
        removeOwnStagingData(t.stagingDir, t.retainStagingLink ? recorded.stagingName : undefined);
        return { kind: "ADOPTED", dev: String(fresh.dev), ino: String(fresh.ino) };
      }
    } finally { fs.closeSync(fd); }
  }
  removeOwnStagingData(t.stagingDir); // our own unlinked copies only; the canonical file is never touched
  return { kind: "COLLISION", detail: "canonical name exists and is not this operation's recorded verified copy" };
}

export async function publishVerifiedCopy(t: CopyTarget, ledger: CopyLedger, hook: CopyHook = () => {}): Promise<CopyOutcome> {
  const canonical = path.join(t.canonicalDir, t.canonicalName);
  if (fs.existsSync(canonical)) return resolveExisting(t, ledger, canonical);
  removeOwnStagingData(t.stagingDir); // incomplete or unlinked copies from a crashed attempt are never reused
  let source: number;
  try { source = fs.openSync(t.source, "r"); } catch (e: any) { if (e?.code === "ENOENT") return { kind: "SOURCE_MISSING", detail: e.code }; throw e; }
  let staged = -1, stagedPath = "";
  try {
    const st = fs.fstatSync(source, { bigint: true });
    if (!st.isFile() || String(st.dev) !== t.seal.dev || String(st.ino) !== t.seal.ino) return { kind: "SOURCE_REPLACED" };
    await hook("source-opened");
    fs.mkdirSync(t.stagingDir, { recursive: true, mode: 0o700 });
    const stagingDev = String(fs.statSync(t.stagingDir, { bigint: true }).dev), canonicalDev = String(fs.statSync(t.canonicalDir, { bigint: true }).dev);
    if (stagingDev !== canonicalDev) throw new Error("PHOTO_PUBLICATION_STAGING_DEVICE_MISMATCH");
    const stagingName = "data-" + randomBytes(8).toString("hex");
    stagedPath = path.join(t.stagingDir, stagingName);
    // O_RDWR|O_CREAT|O_EXCL: a fresh publisher-owned inode, read back through the same descriptor for verification.
    staged = fs.openSync(stagedPath, "wx+", 0o600);
    await hook("staging-created", { fd: staged });
    const chunk = Buffer.alloc(t.chunkSize ?? 64 * 1024);
    let position = 0, first = true;
    for (;;) {
      const n = fs.readSync(source, chunk, 0, chunk.length, position);
      if (n === 0) break;
      fs.writeSync(staged, chunk, 0, n, position);
      position += n;
      if (first) { first = false; await hook("copy-partial", { fd: staged }); }
    }
    fs.fsyncSync(staged);
    await hook("copied", { fd: staged });
    const verified = hashFd(staged);
    if (verified.sha256 !== t.seal.sha256 || verified.bytes !== t.seal.size) {
      fs.closeSync(staged); staged = -1; removeOwnStagingData(t.stagingDir);
      return { kind: "SNAPSHOT_MISMATCH" };
    }
    const copy = { stagingName, ...identity(fs.fstatSync(staged, { bigint: true })), sha256: t.seal.sha256, bytes: t.seal.size };
    fs.closeSync(staged); staged = -1; // no write descriptor is retained after verification
    fsyncDir(t.stagingDir);
    await hook("verified");
    await ledger.record(copy); // durable and authority-fenced, BEFORE any canonical name exists
    await hook("recorded");
    try { fs.linkSync(stagedPath, canonical); } // never replaces an existing name
    catch (e: any) { if (e?.code === "EEXIST") return resolveExisting(t, ledger, canonical); throw e; }
    fsyncDir(t.canonicalDir);
    await hook("linked");
    if (!t.retainStagingLink) { removeOwnStagingData(t.stagingDir); fsyncDir(t.stagingDir); }
    await hook("cleaned");
    return { kind: "PUBLISHED", dev: copy.dev, ino: copy.ino };
  } catch (error) {
    // Disk exhaustion or I/O failure: no canonical name was created by this attempt; drop our partial copy only.
    if (staged >= 0) { try { fs.closeSync(staged); } catch { /* already reported */ } staged = -1; }
    if (stagedPath && !fs.existsSync(canonical)) { try { removeOwnStagingData(t.stagingDir); } catch { /* keep the original failure */ } }
    throw error;
  } finally {
    if (staged >= 0) fs.closeSync(staged);
    fs.closeSync(source);
  }
}
