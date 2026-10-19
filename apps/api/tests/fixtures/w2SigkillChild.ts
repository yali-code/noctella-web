/**
 * FAZ A #463 F5 child process (test fixture only): runs one fenced W2 upload against the disposable SQLite file and
 * photo root given in its environment, reports when it reaches the requested stage boundary, then waits forever so
 * the parent can SIGKILL it there. Never used outside photoOwnershipSigkillRecovery.test.ts.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const stage = process.env.F5_KILL_STAGE as "beforeSeal" | "afterSeal" | "afterIntent" | "afterPublish" | "afterCommit";
  const { db } = await import("../../src/db/client");
  const { uploadFencedProductPhoto } = await import("../../src/services/w2FencedProductPhotoOwner");
  const { digestW2StagedInput } = await import("../../src/services/w2StagedInputDigest");
  const workDir = process.env.F5_WORK_DIR!;
  const bytes = Buffer.from(process.env.F5_INPUT_BASE64!, "base64");
  await writeFile(path.join(workDir, "input"), bytes);
  const file = { path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
  const park = () => {
    // A pending Promise does not keep Node alive. Keep a referenced handle until the controller kills this
    // disposable fixture, so PARKED really means a live executor rather than an already recoverable process.
    setInterval(() => undefined, 60_000);
    process.send?.(`at:${stage}`);
    return new Promise<never>(() => undefined);
  };
  if (stage === "beforeSeal") {
    const { stagedProductPhotoStorage } = await import("../../src/services/stagedProductPhotoStorage");
    stagedProductPhotoStorage.prepareFencedProductPhoto = park; // test child only: claimed/private directory exists, nothing sealed
  }
  await uploadFencedProductPhoto(db as any, {
    productId: process.env.F5_PRODUCT_ID!, actorId: process.env.F5_ACTOR_ID || "actor-1", operationToken: process.env.F5_TOKEN!,
    sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file,
  }, { driver: process.env.F5_DRIVER === "postgres" ? "postgres" : "sqlite", hooks: stage === "beforeSeal" ? {} : { [stage]: park } });
  process.send?.("finished-without-parking");
}
main().catch((error) => { process.send?.(`error:${String(error?.message ?? error)}`); process.exitCode = 2; });
