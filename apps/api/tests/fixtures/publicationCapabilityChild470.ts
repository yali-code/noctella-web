/** #470 offline worker: actual W2/W4 owner, optionally confined by the native test launcher before Node starts. */
import { writeFile, link, symlink } from "node:fs/promises";
import path from "node:path";

async function main() {
  const { db, dbRuntime } = await import("../../src/db/client");
  const driver = process.env.F470_DRIVER === "postgres" ? "postgres" : "sqlite";
  const workDir = process.env.F470_WORK!;
  const input = Buffer.from(process.env.F470_INPUT!, "base64");
  await writeFile(path.join(workDir, "input"), input);
  const pause = async () => {
    process.send?.({ event: "sealed", uid: process.getuid?.() });
    const command = await new Promise<string>(resolve => process.once("message", m => resolve(String(m))));
    if (command === "close-db-and-resume") await dbRuntime.shutdown();
  };
  try {
    if (process.env.F470_KIND === "w4") {
      const { buildFencedAiIntakePhotoFinalizationManifest } = await import("../../src/services/w4FencedFinalizationOwner");
      await buildFencedAiIntakePhotoFinalizationManifest(db as any, async () => input,
        [{ id: process.env.F470_TOKEN!, storageKey: "synthetic.webp" }] as any,
        process.env.F470_PRODUCT!, undefined, { driver, hooks: { afterSeal: pause } });
    } else {
      const { uploadFencedProductPhoto } = await import("../../src/services/w2FencedProductPhotoOwner");
      const { digestW2StagedInput } = await import("../../src/services/w2StagedInputDigest");
      const file = { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal };
      await uploadFencedProductPhoto(db as any, { productId: process.env.F470_PRODUCT!, actorId: "actor-1", operationToken: process.env.F470_TOKEN!, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver, hooks: { afterSeal: pause } });
    }
    process.send?.({ event: "UNEXPECTED_PUBLICATION" });
  } catch (error: any) {
    // Also try a symlink alias from the allowed work directory to the denied canonical hierarchy.
    let aliasCode = "UNEXPECTED_ALIAS_PUBLICATION";
    try {
      const alias = path.join(workDir, "canonical-alias");
      await symlink(process.env.PRODUCT_PHOTO_DIR!, alias);
      await link(path.join(workDir, "input"), path.join(alias, "forbidden-alias.webp"));
    } catch (aliasError: any) { aliasCode = aliasError.code; }
    process.send?.({ event: "denied", code: error.code, aliasCode });
  }
  // Remain alive until the test supervisor kills and observes this exact process's exit.
  setInterval(() => {}, 1000);
}
main().catch(error => { process.send?.({ event: "fixture-error", message: String(error?.message ?? error) }); process.exitCode = 2; });
