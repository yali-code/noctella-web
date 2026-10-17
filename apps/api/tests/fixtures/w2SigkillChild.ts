/**
 * FAZ A #463 F5 child process (test fixture only): runs one fenced W2 upload against the disposable SQLite file and
 * photo root given in its environment, reports when it reaches the requested stage boundary, then waits forever so
 * the parent can SIGKILL it there. Never used outside photoOwnershipSigkillRecovery.test.ts.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const stage = process.env.F5_KILL_STAGE as "afterSeal" | "afterPublish" | "afterCommit";
  const { db } = await import("../../src/db/client");
  const { uploadFencedProductPhoto } = await import("../../src/services/w2FencedProductPhotoOwner");
  const { digestW2StagedInput } = await import("../../src/services/w2StagedInputDigest");
  const workDir = process.env.F5_WORK_DIR!;
  const bytes = Buffer.from(process.env.F5_INPUT_BASE64!, "base64");
  await writeFile(path.join(workDir, "input"), bytes);
  const file = { path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
  const park = () => { process.send?.(`at:${stage}`); return new Promise<never>(() => undefined); };
  await uploadFencedProductPhoto(db as any, {
    productId: process.env.F5_PRODUCT_ID!, actorId: "actor-1", operationToken: process.env.F5_TOKEN!,
    sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file,
  }, { driver: "sqlite", hooks: { [stage]: park } });
  process.send?.("finished-without-parking");
}
main().catch((error) => { process.send?.(`error:${String(error?.message ?? error)}`); process.exitCode = 2; });
