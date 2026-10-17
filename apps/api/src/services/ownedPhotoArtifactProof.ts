import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileProof } from "./photoOperationAuthority";

const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const changed = (): never => { throw new Error("PHOTO_ARTIFACT_CHANGED"); };

/**
 * Descriptor-bound proof for the live W2/W4 fenced owners only. Hash/stat describe one opened regular file;
 * observed replacement, growth or mutation is refused. This is NOT a rooted publication capability: trusted
 * ancestors/ACLs, atomic publication authority, canonical provenance and durability remain separate contracts.
 * W11 deliberately retains its existing inactive helper pending its separate authorization boundary.
 */
export async function ownedPhotoArtifactProof(file: string): Promise<FileProof> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("PHOTO_ARTIFACT_NOT_REGULAR");
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 0) changed();
  // O_NOFOLLOW covers the final POSIX component; O_NONBLOCK avoids a replaced FIFO hanging open().
  const posixFlags = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(file, constants.O_RDONLY | posixFlags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !unchanged(before, opened)) changed();
    const buffer = Buffer.alloc(64 * 1024), hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      // At most the validated size plus one sentinel byte; concurrent growth cannot cause an unbounded read.
      const result = await handle.read(buffer, 0, Math.min(buffer.length, size - bytes + 1), null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > size) changed();
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (!unchanged(opened, after) || !unchanged(after, named) || !named.isFile() || named.isSymbolicLink() || BigInt(bytes) !== after.size) changed();
    return { sha256: hash.digest("hex"), bytes, dev: String(after.dev), ino: String(after.ino) };
  } finally { await handle.close(); }
}
