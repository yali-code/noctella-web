/**
 * Stage 5 F2 (#472): runtime publication executor, exit authenticator and readiness for protected publication.
 *
 * EXECUTOR. The publication executor is this API process (trusted runtime code). Its identity binds the kernel boot,
 * the PID namespace, the PID and the process start time (Linux /proc) plus a per-process nonce. Every T1 intent gets a
 * fresh token registered in this process's execution registry until the owner's work for it has fully settled
 * (publication AND commit, or failure). Image preparation runs in-process into generation-private files; no separate
 * worker principal exists, so no worker descriptor or alias can survive into publication: the publisher copies sealed
 * bytes into its own inode.
 *
 * EXIT AUTHENTICATION (the only way authority moves to a new executor):
 * - Same process: the earlier execution is proven ended iff its token is no longer registered (the registry entry is
 *   released only after every awaited step of that execution has settled).
 * - Another process: proven terminated only when it ran in the same boot and the same PID namespace as this process
 *   and /proc shows that PID absent, a zombie, or started at a different time (PID reuse).
 * - Anything else (other host or container, platform without /proc, unreadable identity) is NOT proven: BLOCKED for
 *   operator review. Lease expiry, a missing heartbeat or a worker-reported PID never prove termination.
 * - PostgreSQL backends of a dead executor cannot commit later: commit happens only in T2, whose intent fence
 *   row-locks photo_operations before COMMIT, and transfer takes the same row lock, so it waits for that backend to
 *   finish (commit -> terminal; abort -> transfer). A dead client cannot send new statements.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import sharp from "sharp";
import type { DbClient } from "../db/client";
import { PhotoUploadError } from "./photoUploadAdmission";
import { inOwnershipTransaction, photoOperationPrivateRoot, type OwnershipDriver, type Rows } from "./photoOperationAuthority";
import {
  exactPositiveInteger, readPublicationCopySteps, recordPublicationCopySteps, reviewPublicationIntentSteps, transferAfterAuthenticatedExitSteps,
  type AuthenticatedResume, type ExecutorExitEvidence, type PublicationAuthority, type PublicationCopyRow, type PublicationExecutor,
} from "./photoPublicationIntents";
import { publishVerifiedCopy, type CopyOutcome, type CopyPhase } from "./photoCopyPublisher";
import { assertPreparationConfinementReady } from "./photoPreparationConfinement";

interface LinuxProcess { bootId: string; pidNs: string; pid: number; start: string }

/** Returns the stat start time and state of a PID, or null when /proc has no such process. */
function procStat(pid: number | "self"): { state: string; start: string } | null {
  let raw: string;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch (e: any) { if (e?.code === "ENOENT" || e?.code === "ESRCH") return null; throw e; }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" "); // field 3 (state) is index 0, field 22 (starttime) index 19
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error("PHOTO_EXECUTOR_PROC_STAT_UNREADABLE");
  return { state: fields[0], start: fields[19] };
}

function currentLinuxProcess(): LinuxProcess | null {
  if (process.platform !== "linux") return null;
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidNs = (/^pid:\[(\d+)\]$/.exec(fs.readlinkSync("/proc/self/ns/pid")) ?? [])[1];
    const self = procStat("self");
    if (!/^[0-9a-f-]{36}$/.test(bootId) || !pidNs || !self) return null;
    return { bootId, pidNs, pid: process.pid, start: self.start };
  } catch { return null; }
}

const NONCE = randomBytes(8).toString("hex");
const SELF = currentLinuxProcess();
const IDENTITY = SELF ? `px1:${SELF.bootId}:${SELF.pidNs}:${SELF.pid}:${SELF.start}:${NONCE}` : `px1u:${process.platform}:${process.pid}:${NONCE}`;
/** This process's publication executor identity (stable for the process lifetime). */
export const publicationExecutorIdentity = () => IDENTITY;
/** Whether this platform can prove the termination of another process (Linux /proc in one boot and PID namespace). */
export const crossProcessExitAuthenticationAvailable = () => SELF !== null;

const activeTokens = new Set<string>();
export interface PublicationScope { executor(): PublicationExecutor; close(): void }
/**
 * One owner execution (one request). Every intent token it takes stays registered until close(); close() must run
 * only after all of the execution's awaited work has settled (use try/finally around the whole execution).
 */
export function openPublicationScope(): PublicationScope {
  const tokens: string[] = [];
  let closed = false;
  return {
    executor() {
      if (closed) throw new Error("PHOTO_PUBLICATION_SCOPE_CLOSED");
      const token = randomUUID();
      activeTokens.add(token); tokens.push(token);
      return { token, executorIdentity: IDENTITY };
    },
    close() { closed = true; for (const token of tokens) activeTokens.delete(token); },
  };
}

/** Trusted exit authenticator (see the module header). Pure function of the identity, the token and local /proc state. */
export function authenticateExecutorExit(current: { token: string; executorIdentity: string }): ExecutorExitEvidence {
  if (current.executorIdentity === IDENTITY)
    return activeTokens.has(current.token) ? { proven: false, reason: "the executor is still running in this process" } : { proven: true, attestedBy: `self-ended:${IDENTITY}` };
  const parts = /^px1:([0-9a-f-]{36}):(\d+):(\d+):(\d+):[0-9a-f]{16}$/.exec(current.executorIdentity);
  if (!parts) return { proven: false, reason: "executor identity cannot be authenticated on this platform" };
  if (!SELF) return { proven: false, reason: "this process cannot observe other processes (no Linux /proc)" };
  const [, bootId, pidNs, pid, start] = parts;
  if (bootId !== SELF.bootId) return { proven: false, reason: "executor ran in another boot or host" };
  if (pidNs !== SELF.pidNs) return { proven: false, reason: "executor ran in another PID namespace" };
  let stat: ReturnType<typeof procStat>;
  try { stat = procStat(Number(pid)); } catch { return { proven: false, reason: "executor process state is unreadable" }; }
  const evidence = `${IDENTITY}|pid ${pid}`;
  if (!stat) return { proven: true, attestedBy: `${evidence} absent`.slice(0, 256) };
  if (stat.start !== start) return { proven: true, attestedBy: `${evidence} reused`.slice(0, 256) };
  if (stat.state === "Z" || stat.state === "X") return { proven: true, attestedBy: `${evidence} exited`.slice(0, 256) };
  return { proven: false, reason: "the executor process is alive" };
}

/** Resume an authorized intent whose executor is proven terminated; otherwise none/blocked/terminal. */
export async function resumeAfterAuthenticatedExit(db: DbClient, driver: OwnershipDriver, operationId: string, scope: PublicationScope): Promise<AuthenticatedResume> {
  const me = scope.executor();
  return inOwnershipTransaction(db, driver, () => transferAfterAuthenticatedExitSteps(driver, operationId, authenticateExecutorExit, me));
}

export const photoPublicationStagingRoot = (canonicalRoot: string) => path.join(path.dirname(path.resolve(canonicalRoot)), ".product-photo-publication");
const operationStagingDir = (canonicalRoot: string, operationId: string) => path.join(photoPublicationStagingRoot(canonicalRoot), operationId);
export const sealedArtifactPath = (canonicalRoot: string, a: Pick<PublicationAuthority, "operationId" | "generation">, artifact: "main" | "thumb") =>
  path.join(photoOperationPrivateRoot(canonicalRoot), a.operationId, String(a.generation), `${artifact}.webp`);

/**
 * Fail-closed readiness of protected publication: the intent, exit-record and copy tables exist, and the canonical,
 * operation-private and publication-staging roots are directories on ONE filesystem (link() of a verified copy).
 * Never falls back to linking worker-owned inodes.
 */
export async function assertPhotoPublicationReady(db: DbClient, driver: OwnershipDriver, canonicalRoot: string): Promise<void> {
  assertPreparationConfinementReady(); // an invalid PHOTO_PREPARATION_CONFINEMENT is never ignored
  try {
    await inOwnershipTransaction(db, driver, function* (): Generator<SQL, void, Rows> {
      yield sql`SELECT operation_id FROM photo_publication_intents WHERE 1 = 0`;
      yield sql`SELECT operation_id FROM photo_executor_exit_records WHERE 1 = 0`;
      yield sql`SELECT operation_id FROM photo_publication_copies WHERE 1 = 0`;
    });
  } catch { throw new PhotoUploadError(503, "PHOTO_PUBLICATION_NOT_READY", "Protected photo publication schema is not installed"); }
  try {
    const roots = [path.resolve(canonicalRoot), photoOperationPrivateRoot(canonicalRoot), photoPublicationStagingRoot(canonicalRoot)];
    fs.mkdirSync(roots[0], { recursive: true });
    for (const root of roots.slice(1)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const devices = new Set(roots.map((root) => { const st = fs.statSync(root, { bigint: true }); if (!st.isDirectory()) throw new Error("not a directory"); return String(st.dev); }));
    if (devices.size !== 1) throw new Error("roots on different filesystems");
  } catch { throw new PhotoUploadError(503, "PHOTO_PUBLICATION_NOT_READY", "Protected photo publication storage is not ready"); }
}

const STORAGE_ERRORS = new Set(["ENOSPC", "EDQUOT", "EIO", "EROFS", "EMFILE", "ENFILE", "EACCES", "EPERM", "EXDEV"]);

/**
 * Copy-owned publication of both artifacts of ONE authorized intent, by its current executor only. PUBLISHED/ADOPTED
 * continue; any other outcome moves the operation and intent to review (nothing overwritten or deleted). Storage
 * failures leave no canonical name from this attempt and are retryable (the intent stays authorized).
 */
export async function publishAuthorizedArtifacts(db: DbClient, driver: OwnershipDriver, a: PublicationAuthority, canonicalRoot: string,
  hook: (artifact: "main" | "thumb", phase: CopyPhase) => void | Promise<void> = () => {}): Promise<Record<"main" | "thumb", CopyOutcome>> {
  const [sizes] = await inOwnershipTransaction(db, driver, function* (): Generator<SQL, Rows, Rows> {
    return yield sql`SELECT main_bytes, thumb_bytes FROM photo_operation_artifacts WHERE id = ${a.sealId} AND operation_id = ${a.operationId} AND generation = ${a.generation}`;
  });
  if (!sizes) throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Sealed photo artifact record is missing");
  const outcomes = {} as Record<"main" | "thumb", CopyOutcome>;
  for (const artifact of ["main", "thumb"] as const) {
    const ledger = {
      read: async () => inOwnershipTransaction(db, driver, () => readPublicationCopySteps(a.operationId, artifact)),
      record: async (copy: PublicationCopyRow) => {
        if (!(await inOwnershipTransaction(db, driver, () => recordPublicationCopySteps(driver, a, artifact, copy))))
          throw new PhotoUploadError(409, "PHOTO_OPERATION_FENCE_LOST", "Photo publication authority was lost");
      },
    };
    let outcome: CopyOutcome;
    try {
      outcome = await publishVerifiedCopy({
        source: sealedArtifactPath(canonicalRoot, a, artifact),
        seal: { sha256: a.identity[artifact].sha256, size: exactPositiveInteger(sizes[`${artifact}_bytes`]), dev: a.identity[artifact].dev, ino: a.identity[artifact].ino },
        canonicalDir: path.resolve(canonicalRoot), canonicalName: artifact === "main" ? a.mainKey : a.thumbKey,
        stagingDir: path.join(operationStagingDir(canonicalRoot, a.operationId), artifact),
      }, ledger, (phase) => hook(artifact, phase));
    } catch (error: any) {
      if (error instanceof PhotoUploadError) throw error;
      if (STORAGE_ERRORS.has(error?.code) || error?.message === "PHOTO_PUBLICATION_STAGING_DEVICE_MISMATCH")
        throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo storage is unavailable");
      throw error;
    }
    outcomes[artifact] = outcome;
    if (outcome.kind !== "PUBLISHED" && outcome.kind !== "ADOPTED") {
      await inOwnershipTransaction(db, driver, () => reviewPublicationIntentSteps(driver, a, `copy-owned publication ${artifact}: ${outcome.kind}`));
      throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Canonical photo key does not match the sealed artifact");
    }
  }
  return outcomes;
}

/** Width/height of the PUBLISHED (publisher-owned, verified) main artifact; used when resuming another execution. */
export async function publishedMainDimensions(canonicalRoot: string, mainKey: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(path.join(canonicalRoot, mainKey)).metadata();
  if (!meta.width || !meta.height) throw new PhotoUploadError(409, "PHOTO_OPERATION_REVIEW", "Published photo dimensions are unreadable");
  return { width: meta.width, height: meta.height };
}

/** Removes this operation's own staging namespace and the committed generation's private files (after T2 only). */
export async function cleanupCommittedPublication(canonicalRoot: string, a: Pick<PublicationAuthority, "operationId" | "generation">): Promise<void> {
  await Promise.allSettled([
    fs.promises.rm(operationStagingDir(canonicalRoot, a.operationId), { recursive: true, force: true }),
    fs.promises.unlink(sealedArtifactPath(canonicalRoot, a, "main")),
    fs.promises.unlink(sealedArtifactPath(canonicalRoot, a, "thumb")),
  ]);
}
