/**
 * Stage 5 F2 (#472) confined photo-preparation worker. Started only by photoPreparationConfinement through the Landlock
 * launcher (writes allowed solely beneath its generation directory and its job directory; no database, no secrets in
 * its environment). Runs the unchanged W2/W4 derivative recipe and prints exactly one JSON line; the trusted parent
 * seals the outputs only after this process has exited.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const job = JSON.parse(Buffer.from(process.env.PHOTO_PREPARATION_JOB ?? "", "base64").toString("utf8"));
  if (job.kind === "w2") {
    const { stagedProductPhotoStorage } = await import("../services/stagedProductPhotoStorage");
    const prepared = await stagedProductPhotoStorage.prepareFencedProductPhoto(
      { path: job.inputPath, workDir: job.workDir, size: job.size, mimetype: job.mimetype, signal: new AbortController().signal } as any, job.outDir);
    return { main: prepared.main, thumb: prepared.thumb, width: prepared.width, height: prepared.height };
  }
  if (job.kind === "w4") {
    const { prepareDeterministicProductPhotoFiles } = await import("../services/photoStorage");
    const buffer = readFileSync(job.inputPath);
    const prepared = await prepareDeterministicProductPhotoFiles({ buffer, mimetype: job.mimetype, size: buffer.length }, job.outDir);
    return { main: prepared.main, thumb: prepared.thumb, width: prepared.width, height: prepared.height };
  }
  if (job.kind === "instagram") {
    const { renderInstagramDerivative } = await import("../integrations/instagram/instagramDerivativeRecipe");
    const { runImageOperation } = await import("../services/photoUploadAdmission");
    const bytes = await runImageOperation(() => renderInstagramDerivative(readFileSync(job.inputPath), job.recipe));
    const derivative = path.join(job.outDir, "derivative.jpg");
    writeFileSync(derivative, bytes, { flag: "wx", mode: 0o600 });
    return { derivative };
  }
  throw Object.assign(new Error("unknown preparation job"), { status: 500, code: "PHOTO_PREPARATION_JOB_INVALID" });
}

main().then(
  (result) => { process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n"); },
  (error: any) => {
    process.stdout.write(JSON.stringify({ ok: false, status: typeof error?.status === "number" ? error.status : 500, code: typeof error?.code === "string" ? error.code : "PHOTO_PREPARATION_FAILED", message: String(error?.message ?? error).slice(0, 300) }) + "\n");
    process.exitCode = 3;
  },
);
