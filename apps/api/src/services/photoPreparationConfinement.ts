/**
 * Stage 5 F2 (#472) MANDATORY confinement of untrusted image preparation in protected mode.
 *
 * Threat model (Steps 2-4, unchanged): preparation workers are UNTRUSTED. A same-UID process that is not confined can
 * write every published copy (mode 0600, owned by the API UID), the publisher's staging anchors and private files, and
 * read /proc/<api>/environ and /proc/<api>/fd (credentials, open canonical descriptors). Ownership, 0700 directories
 * and publisher-owned copies do NOT isolate such a process. Integrity of published bytes and of the authority records
 * therefore REQUIRES the Landlock boundary: protected mode (PHOTO_OWNERSHIP_FENCING_ENABLED=true) is NOT READY unless
 * PHOTO_PREPARATION_CONFINEMENT=required and PHOTO_PREPARATION_LAUNCHER names an executable launcher on Linux.
 *
 * In-process preparation (the decoder runs inside the API process, so a decoder compromise IS an API compromise; nothing
 * is isolated) is accepted ONLY as an explicitly UNPROTECTED mode for NODE_ENV=test or development. It is never a
 * production configuration and never a fallback.
 *
 * Worker lifecycle: writes are allowed only beneath the generation directory and a per-job directory; its environment
 * carries no database URL or secret; stdio is /dev/null + parent sockets (verified by the launcher, which closes every
 * other descriptor); the launcher must report LANDLOCK_ENFORCED; the parent waits for the worker's exit (and kills it on
 * timeout or abort) BEFORE the outputs are sealed. Descendants inherit the confinement; a surviving descendant can at
 * most change private bytes, which then fail copy verification (SNAPSHOT_MISMATCH -> review) and never reach a
 * published inode.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PhotoUploadError } from "./photoUploadAdmission";

export type PreparationConfinement = { mode: "in-process-unprotected" } | { mode: "confined"; launcher: string } | { mode: "invalid"; reason: string };
const UNPROTECTED_ALLOWED = ["test", "development"];

export function photoPreparationConfinementConfig(env: NodeJS.ProcessEnv = process.env): PreparationConfinement {
  const raw = env.PHOTO_PREPARATION_CONFINEMENT;
  if (raw === undefined || raw === "") {
    return UNPROTECTED_ALLOWED.includes(env.NODE_ENV ?? "") ? { mode: "in-process-unprotected" }
      : { mode: "invalid", reason: "protected publication requires PHOTO_PREPARATION_CONFINEMENT=required (untrusted preparation must be Landlock-confined)" };
  }
  if (raw !== "required") return { mode: "invalid", reason: `invalid PHOTO_PREPARATION_CONFINEMENT value ${JSON.stringify(raw)}` };
  if (process.platform !== "linux") return { mode: "invalid", reason: "confined preparation requires Linux (Landlock)" };
  const launcher = env.PHOTO_PREPARATION_LAUNCHER;
  if (!launcher || !path.isAbsolute(launcher)) return { mode: "invalid", reason: "PHOTO_PREPARATION_LAUNCHER must be an absolute path" };
  try { fs.accessSync(launcher, fs.constants.X_OK); if (!fs.statSync(launcher).isFile()) throw new Error("not a file"); }
  catch { return { mode: "invalid", reason: "PHOTO_PREPARATION_LAUNCHER is missing or not executable" }; }
  return { mode: "confined", launcher };
}

/** Readiness part of assertPhotoPublicationReady: an invalid confinement configuration is never ignored. */
export function assertPreparationConfinementReady(env: NodeJS.ProcessEnv = process.env): void {
  const config = photoPreparationConfinementConfig(env);
  if (config.mode === "invalid") throw new PhotoUploadError(503, "PHOTO_PUBLICATION_NOT_READY", `Photo preparation confinement is not ready: ${config.reason}`);
}

/** Non-secret configuration the recipe may read; everything else (DATABASE_*, keys, tokens) is withheld. */
function workerEnvironment(jobDir: string, job: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, TMPDIR: jobDir, HOME: jobDir, PHOTO_PREPARATION_JOB: job };
  for (const [key, value] of Object.entries(process.env))
    if (/^(PRODUCT_PHOTO_|PHOTO_UPLOAD_|PHOTO_IMAGE_|VIPS_)/.test(key) && !/SECRET|TOKEN|KEY|PASSWORD/i.test(key)) env[key] = value;
  return env;
}

export interface PreparedFiles { main: string; thumb: string; width: number; height: number }
export interface ConfinedJob { kind: "w2" | "w4"; inputPath: string; workDir?: string; size: number; mimetype: string; outDir: string }
/** Instagram derivative rendering (#472 parity 4B): reads the canonical source, writes only <outDir>/derivative.jpg. */
export interface ConfinedDerivativeJob { kind: "instagram"; inputPath: string; recipe: string; outDir: string }

const WORKER = path.join(__dirname, "..", "workers", __filename.endsWith(".ts") ? "photoPreparationWorker.ts" : "photoPreparationWorker.js");

/**
 * Runs one preparation job in a confined worker and returns only after the worker process has exited. `workerScript`
 * is a test seam (capability probes); the production owners never pass it.
 */
export async function prepareInConfinedWorker(launcher: string, job: ConfinedJob, jobDir: string,
  options: { signal?: AbortSignal; timeoutMs?: number; workerScript?: string } = {}): Promise<PreparedFiles & { enforced: string }> {
  const { result, exit, enforced } = await runConfinedJob(launcher, job, jobDir, options);
  const expected = { main: path.join(job.outDir, "main.webp"), thumb: path.join(job.outDir, "thumb.webp") };
  if (exit.code !== 0 || result.main !== expected.main || result.thumb !== expected.thumb || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height))
    throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Photo preparation worker returned an invalid result");
  return { ...expected, width: result.width, height: result.height, enforced };
}

/** Renders one Instagram derivative in a confined worker; returns the bytes it wrote, after the worker has exited. */
export async function renderDerivativeInConfinedWorker(launcher: string, job: ConfinedDerivativeJob, jobDir: string,
  options: { timeoutMs?: number; workerScript?: string } = {}): Promise<{ bytes: Buffer; enforced: string }> {
  const { result, exit, enforced } = await runConfinedJob(launcher, job, jobDir, options);
  const expected = path.join(job.outDir, "derivative.jpg");
  if (exit.code !== 0 || result.derivative !== expected) throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Derivative worker returned an invalid result");
  const st = fs.lstatSync(expected);
  if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > 8 * 1024 * 1024) throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Derivative worker output is invalid");
  return { bytes: fs.readFileSync(expected), enforced };
}

async function runConfinedJob(launcher: string, job: ConfinedJob | ConfinedDerivativeJob, jobDir: string,
  options: { signal?: AbortSignal; timeoutMs?: number; workerScript?: string }): Promise<{ result: any; exit: { code: number | null; signal: NodeJS.Signals | null }; enforced: string }> {
  const script = options.workerScript ?? WORKER;
  const node = script.endsWith(".ts") ? [process.execPath, "--import", "tsx", script] : [process.execPath, script];
  const child = spawn(launcher, [job.outDir, jobDir, "--", ...node], {
    cwd: path.resolve(__dirname, "..", ".."), stdio: ["ignore", "pipe", "pipe"],
    env: workerEnvironment(jobDir, Buffer.from(JSON.stringify(job)).toString("base64")),
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (d) => { if (stdout.length < 64 * 1024) stdout += d; });
  child.stderr!.on("data", (d) => { if (stderr.length < 64 * 1024) stderr += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  const timer = setTimeout(kill, options.timeoutMs ?? 120_000);
  const onAbort = () => kill();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try { exit = await exited; } // the worker is gone before anything is sealed
  catch { throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Photo preparation worker could not start"); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
  if (options.signal?.aborted) throw options.signal.reason ?? new PhotoUploadError(499, "PHOTO_UPLOAD_ABORTED", "Photo upload was aborted");
  const enforced = /^LANDLOCK_ENFORCED abi=(\d+)/m.exec(stderr);
  if (!enforced) throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Photo preparation worker was not confined");
  let result: any;
  try { result = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { result = null; }
  if (!result || exit.signal) throw new PhotoUploadError(503, "PHOTO_PREPARATION_UNAVAILABLE", "Photo preparation worker did not complete");
  if (!result.ok) throw new PhotoUploadError(Number(result.status) || 500, String(result.code || "PHOTO_PREPARATION_FAILED"), String(result.message || "Photo preparation failed"));
  return { result, exit, enforced: `abi=${enforced[1]}` };
}

/** Per-job writable directory next to the generation directory (same private root), removed after the worker exits. */
export async function withPreparationJobDir<T>(generationDir: string, fn: (jobDir: string) => Promise<T>): Promise<T> {
  const jobDir = generationDir + ".job";
  await fs.promises.mkdir(jobDir, { mode: 0o700 });
  try { return await fn(jobDir); } finally { await fs.promises.rm(jobDir, { recursive: true, force: true }); }
}
