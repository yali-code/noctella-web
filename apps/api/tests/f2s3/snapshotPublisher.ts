/**
 * #472 F2 Step 3 test ADAPTER over the RUNTIME copy-owned publisher (src/services/photoCopyPublisher.ts).
 *
 * The Step 3 and Step 4 suites keep their filesystem-manifest ledger (manifest.json in the operation's staging
 * directory, written durably before the canonical link), so they exercise the runtime publication, verification,
 * adoption, collision and cleanup decisions rather than a parallel test-only implementation. The runtime owners use the
 * database ledger (photo_publication_copies, migration 0044) instead of this file manifest.
 *
 * Snapshot integrity  : the staged copy equals the seal (sha256 + size) AND the source is the sealed inode (dev, ino).
 * Byte immutability   : after publication no worker holds a write path to the published inode (Step 2 confinement).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { publishVerifiedCopy, type CopyLedger, type CopyOutcome, type CopyPhase } from "../../src/services/photoCopyPublisher";

export interface Seal { sha256: string; size: number; dev: string; ino: string }
export interface PublishTarget { source: string; seal: Seal; canonicalDir: string; canonicalName: string; stagingRoot: string; operationId: string; generation: number; chunkSize?: number }
export type Phase = "source-opened" | "staging-created" | "copy-partial" | "copied" | "verified" | "manifest-written" | "linked" | "cleaned";
export type Hook = (phase: Phase, detail: Record<string, unknown>) => void | Promise<void>;
export type Outcome = CopyOutcome;

/** Trusted sealing read (the worker is held at a barrier while this runs). */
export function sealSource(file: string): Seal {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; ;) { const n = fs.readSync(fd, buffer, 0, buffer.length, position); if (n === 0) break; hash.update(buffer.subarray(0, n)); position += n; }
    return { sha256: hash.digest("hex"), size: Number(st.size), dev: String(st.dev), ino: String(st.ino) };
  } finally { fs.closeSync(fd); }
}

export function stagingDir(t: PublishTarget) { return path.join(t.stagingRoot, t.operationId, String(t.generation)); }
const manifestPath = (t: PublishTarget) => path.join(stagingDir(t), "manifest.json");
function fsyncDir(dir: string) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

/** Durable file ledger: the manifest is fsynced and atomically renamed before the runtime publisher links. */
function manifestLedger(t: PublishTarget): CopyLedger {
  return {
    async read() {
      let m: any;
      try { m = JSON.parse(fs.readFileSync(manifestPath(t), "utf8")); } catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
      return { stagingName: String(m.stagingName ?? ""), dev: String(m.dev), ino: String(m.ino), sha256: String(m.sha256), bytes: Number(m.bytes ?? t.seal.size) };
    },
    async record(copy) {
      const tmp = manifestPath(t) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ ...copy, operationId: t.operationId, generation: t.generation }));
      const fd = fs.openSync(tmp, "r+"); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.renameSync(tmp, manifestPath(t)); fsyncDir(stagingDir(t));
    },
  };
}

const PHASES: Record<CopyPhase, Phase> = {
  "source-opened": "source-opened", "staging-created": "staging-created", "copy-partial": "copy-partial", copied: "copied",
  verified: "verified", recorded: "manifest-written", linked: "linked", cleaned: "cleaned",
};

export async function publish(t: PublishTarget, hook: Hook = () => {}): Promise<Outcome> {
  return publishVerifiedCopy(
    { source: t.source, seal: t.seal, canonicalDir: t.canonicalDir, canonicalName: t.canonicalName, stagingDir: stagingDir(t), chunkSize: t.chunkSize },
    manifestLedger(t),
    (phase, detail) => hook(PHASES[phase], { pid: process.pid, ...(detail ?? {}) }),
  );
}

/** NEGATIVE CONTROL ONLY: the rejected design that links the worker's own inode (the 470 LIMIT shape). */
export function publishByLinkingWorkerInode(t: PublishTarget) {
  fs.linkSync(t.source, path.join(t.canonicalDir, t.canonicalName));
}
