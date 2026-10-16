import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * W2 Stage 5: compute a bounded upload intent digest from an already received
 * private staging file. This is NOT a durable claim or canonical publication.
 * The caller must retain its staging reservation and ensure no competing writer
 * can replace the private input while it is being read.
 */
export async function digestW2StagedInput(
  input: { path: string; workDir: string; size: number; signal: AbortSignal },
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("W2_DIGEST_LIMIT_INVALID");
  if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED");
  if (path.resolve(input.path) !== path.join(path.resolve(input.workDir), "input"))
    throw new Error("W2_DIGEST_UNSAFE_PATH");
  const stat = await lstat(input.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.size || stat.size > maxBytes || stat.size < 1)
    throw new Error("W2_DIGEST_UNSAFE_INPUT");
  if (await realpath(input.path) !== path.resolve(input.path)) throw new Error("W2_DIGEST_UNSAFE_PATH");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(input.path, { signal: input.signal, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length;
      if (bytes > maxBytes || bytes > input.size) throw new Error("W2_DIGEST_SIZE_CHANGED");
      hash.update(chunk);
    }
  } catch (error) {
    if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED", { cause: error });
    throw error;
  }
  if (input.signal.aborted) throw new Error("W2_DIGEST_ABORTED");
  if (bytes !== input.size) throw new Error("W2_DIGEST_SIZE_CHANGED");
  const after = await lstat(input.path);
  if (!after.isFile() || after.size !== bytes || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs)
    throw new Error("W2_DIGEST_SIZE_CHANGED");
  return hash.digest("hex");
}
