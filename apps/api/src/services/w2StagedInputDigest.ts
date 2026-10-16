import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * W2 Stage 5 prerequisite only: bounded digest of an already owned private
 * staging file, not a durable operation claim or canonical publication.
 * Hold the private staging reservation throughout the read.
 */
export async function digestW2StagedInput(
  input: { path: string; workDir: string; size: number; signal: AbortSignal },
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("W2_DIGEST_LIMIT_INVALID");
  if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED");
  if (path.resolve(input.path) !== path.join(path.resolve(input.workDir), "input"))
    throw new Error("W2_DIGEST_UNSAFE_PATH");
  const before = await lstat(input.path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== input.size || before.size > maxBytes || before.size < 1)
    throw new Error("W2_DIGEST_UNSAFE_INPUT");
  if (await realpath(input.path) !== path.resolve(input.path)) throw new Error("W2_DIGEST_UNSAFE_PATH");
  // O_NOFOLLOW blocks a symlink swap between lstat and open on supported platforms.
  const handle = await open(input.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error("W2_DIGEST_UNSAFE_INPUT");
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false, signal: input.signal, highWaterMark: 64 * 1024 })) {
        bytes += chunk.length;
        if (bytes > maxBytes || bytes > input.size) throw new Error("W2_DIGEST_SIZE_CHANGED");
        hash.update(chunk);
      }
    } catch (error) {
      if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED", { cause: error });
      throw error;
    }
    if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED");
    const after = await handle.stat();
    const named = await lstat(input.path);
    if (bytes !== input.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink())
      throw new Error("W2_DIGEST_SIZE_CHANGED");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
