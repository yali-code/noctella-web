import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture(data: Buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "noctella-w2-digest-"));
  dirs.push(dir);
  const file = path.join(dir, "input");
  await writeFile(file, data);
  return { file, dir, input: { path: file, workDir: dir, size: data.length, signal: new AbortController().signal } };
}
it("computes byte-identical SHA256 from private input with bounded streaming", async () => {
  const data = Buffer.alloc(200_000, 7);
  const { input } = await fixture(data);
  expect(await digestW2StagedInput(input, 250_000)).toBe(createHash("sha256").update(data).digest("hex"));
});
it("rejects altered size, invalid maximum and paths outside owned staging", async () => {
  const { input, dir } = await fixture(Buffer.from("photo"));
  await expect(digestW2StagedInput({ ...input, size: 4 }, 100)).rejects.toThrow("W2_DIGEST_UNSAFE_INPUT");
  await expect(digestW2StagedInput(input, 4)).rejects.toThrow("W2_DIGEST_UNSAFE_INPUT");
  await expect(digestW2StagedInput(input, 0)).rejects.toThrow("W2_DIGEST_LIMIT_INVALID");
  await expect(digestW2StagedInput({ ...input, path: path.join(dir, "../escape") }, 100)).rejects.toThrow("W2_DIGEST_UNSAFE_PATH");
});
it("rejects aborted reads and symlink inputs", async () => {
  const { input, dir } = await fixture(Buffer.from("photo"));
  const abort = new AbortController(); abort.abort();
  await expect(digestW2StagedInput({ ...input, signal: abort.signal }, 100)).rejects.toThrow("W2_DIGEST_ABORTED");
  const target = path.join(dir, "real");
  await writeFile(target, "photo");
  await rm(input.path);
  await symlink(target, input.path);
  await expect(digestW2StagedInput(input, 100)).rejects.toThrow("W2_DIGEST_UNSAFE_INPUT");
});

it("rejects non-file inputs before opening the reader", async () => {
  const { input, dir } = await fixture(Buffer.from("photo"));
  await rm(input.path);
  await import("node:fs/promises").then(fs => fs.mkdir(input.path));
  await expect(digestW2StagedInput(input, 100)).rejects.toThrow("W2_DIGEST_UNSAFE_INPUT");
  expect(dir).toBeTruthy();
});
