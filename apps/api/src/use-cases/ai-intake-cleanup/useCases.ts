import type {
  AiIntakeCleanupRepository,
  AiIntakeRetentionCleanupRequest,
} from "../../repositories/ai-intake-cleanup/types";
import type { ManagedDirectoryWalkResult, ManagedFileDisposition } from "../../services/managedFileDeletion";

/**
 * Sprint 96: the single canonical UUID shape used for every server-generated
 * id in this codebase (crypto.randomUUID()) - lowercase, hyphenated,
 * 8-4-4-4-12 hex. Anchored end-to-end; never a delimiter split, since both
 * halves of a canonical filename are themselves UUIDs containing hyphens.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRIVATE_STAGED_FILENAME_RE = new RegExp(`^${UUID}\\.webp$`);
const CANONICAL_MAIN_RE = new RegExp(`^(${UUID})-(${UUID})\\.webp$`);
const CANONICAL_THUMB_RE = new RegExp(`^(${UUID})-(${UUID})-thumb\\.webp$`);

/** Exactly matches LocalAiIntakePhotoStorage.saveIntakePhoto's own generated key shape (`${randomUUID()}.webp`) - nothing else. */
export function isPrivateStagedFilename(filename: string): boolean {
  return PRIVATE_STAGED_FILENAME_RE.test(filename);
}

export interface ParsedCanonicalFilename {
  productId: string;
  photoId: string;
  isThumbnail: boolean;
}

/** Exactly matches writeDeterministicProductPhoto's `${productId}-${photoId}.webp` / `${productId}-${photoId}-thumb.webp` shape - never an ordinary-upload `${Date.now()}-${randomUUID()}.webp` filename (a decimal first segment can never match a UUID group). */
export function parseCanonicalFilename(filename: string): ParsedCanonicalFilename | null {
  const main = CANONICAL_MAIN_RE.exec(filename);
  if (main) return { productId: main[1], photoId: main[2], isThumbnail: false };
  const thumb = CANONICAL_THUMB_RE.exec(filename);
  if (thumb) return { productId: thumb[1], photoId: thumb[2], isThumbnail: true };
  return null;
}

export interface AiIntakeCleanupResult {
  executionEnabled: boolean;
  dryRun: boolean;
  filesExamined: number;
  rowsExamined: number;
  stagedRowsEligible: number;
  stagedRowsDeleted: number;
  stagedFilesDeleted: number;
  stagedFilesAlreadyAbsent: number;
  privateOrphansEligible: number;
  privateOrphansDeleted: number;
  canonicalOrphansEligible: number;
  canonicalOrphansDeleted: number;
  liveFilesRetained: number;
  activeSourceRowsRetained: number;
  activeOutboxRetained: number;
  ageProtected: number;
  unknownFilesRetained: number;
  symlinksRetained: number;
  directoriesRetained: number;
  failures: number;
  truncated: boolean;
  durationMs: number;
}

function emptyCounters(): Omit<AiIntakeCleanupResult, "executionEnabled" | "dryRun" | "durationMs"> {
  return {
    filesExamined: 0,
    rowsExamined: 0,
    stagedRowsEligible: 0,
    stagedRowsDeleted: 0,
    stagedFilesDeleted: 0,
    stagedFilesAlreadyAbsent: 0,
    privateOrphansEligible: 0,
    privateOrphansDeleted: 0,
    canonicalOrphansEligible: 0,
    canonicalOrphansDeleted: 0,
    liveFilesRetained: 0,
    activeSourceRowsRetained: 0,
    activeOutboxRetained: 0,
    ageProtected: 0,
    unknownFilesRetained: 0,
    symlinksRetained: 0,
    directoriesRetained: 0,
    failures: 0,
    truncated: false,
  };
}

/**
 * Sprint 96: the empty, zero-count result the service returns directly
 * (without ever invoking runAiIntakeCleanupUseCase, i.e. without scanning
 * any root or querying any retention candidate) for the scheduler's
 * execution-disabled skip. dryRun is always true here - a skipped, forcibly
 * non-destructive run must never report dryRun:false.
 */
export function emptyDisabledCleanupResult(): AiIntakeCleanupResult {
  return { executionEnabled: false, dryRun: true, ...emptyCounters(), durationMs: 0 };
}

export interface AiIntakeCleanupUseCaseDeps {
  repository: AiIntakeCleanupRepository;
  /** A narrow read-only slice of AiIntakePhotoRepository.listByIntake - used only by the dry-run staged-retention count, which must never call the destructive locked-delete method. */
  listStagedPhotosByIntake(intakeId: string): Promise<Array<{ id: string; storageKey: string }>>;
  walkPrivateRoot(options: { maxExamine: number; timeBudgetMs: number; now(): number }): Promise<ManagedDirectoryWalkResult>;
  walkCanonicalRoot(options: { maxExamine: number; timeBudgetMs: number; now(): number }): Promise<ManagedDirectoryWalkResult>;
  deletePrivateFile(key: string): Promise<ManagedFileDisposition>;
  deleteCanonicalFile(key: string): Promise<ManagedFileDisposition>;
}

export interface AiIntakeCleanupInput {
  dryRun: boolean;
  batchSize: number;
  executionEnabled: boolean;
  now: Date;
  processStartedAt: Date;
  cancelledStagedRetentionMs: number;
  finalizedStagedRetentionMs: number;
  orphanGraceMs: number;
  /** Directory-walk operational safety constants (code-owned, not environment-configured - see services/aiIntakeCleanup.ts). */
  maxExaminedEntriesPerRoot: number;
  scanTimeBudgetMsPerRoot: number;
}

function isAgeAndWatermarkEligible(mtimeMs: number | undefined, now: Date, processStartedAt: Date, orphanGraceMs: number): boolean {
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs)) return false;
  const oldEnough = mtimeMs <= now.getTime() - orphanGraceMs;
  const predatesProcessStart = mtimeMs < processStartedAt.getTime();
  return oldEnough && predatesProcessStart;
}

async function cleanStagedRetention(
  deps: AiIntakeCleanupUseCaseDeps,
  input: AiIntakeCleanupInput,
  effectiveDryRun: boolean,
  cutoffs: { cancelledCutoff: string; finalizedCutoff: string },
  counters: ReturnType<typeof emptyCounters>,
): Promise<void> {
  const candidates = await deps.repository.listTerminalIntakesWithStagedPhotosEligibleForRetention({
    cancelledCutoff: cutoffs.cancelledCutoff,
    finalizedCutoff: cutoffs.finalizedCutoff,
    limit: 500,
  });

  let remainingBudget = input.batchSize;
  for (const candidate of candidates) {
    if (remainingBudget <= 0) {
      // More eligible candidate intakes remain in this batch than the action budget allowed to
      // process - genuine destructive-work backlog, not merely "dry-run deletes zero".
      if (!effectiveDryRun) counters.truncated = true;
      break;
    }

    if (effectiveDryRun) {
      let photos: Array<{ id: string; storageKey: string }>;
      try {
        photos = await deps.listStagedPhotosByIntake(candidate.id);
      } catch {
        counters.failures += 1;
        continue;
      }
      counters.rowsExamined += photos.length;
      const eligibleHere = Math.min(photos.length, remainingBudget);
      counters.stagedRowsEligible += eligibleHere;
      remainingBudget -= eligibleHere;
      continue;
    }

    const request: AiIntakeRetentionCleanupRequest =
      candidate.status === "cancelled" ? { kind: "cancelled", cutoff: cutoffs.cancelledCutoff } : { kind: "finalized", cutoff: cutoffs.finalizedCutoff };

    const budgetBeforeThisCandidate = remainingBudget;
    let result;
    try {
      result = await deps.repository.deleteRetentionEligibleStagedPhotosLocked(candidate.id, request, remainingBudget);
    } catch {
      // One intake's failure must not abort the batch - the next candidate is still attempted.
      counters.failures += 1;
      continue;
    }
    if (!result.cleaned) continue; // status changed, not yet eligible, missing audit timestamp, or not found - fail closed, not a failure

    counters.rowsExamined += result.deletedPhotos.length;
    counters.stagedRowsEligible += result.deletedPhotos.length;
    counters.stagedRowsDeleted += result.deletedPhotos.length;
    remainingBudget -= result.deletedPhotos.length;

    // The repository's SELECT is itself bounded by the budget passed in
    // (`.limit(remainingBudget)`) - if it returned exactly that many rows, this candidate may have
    // more eligible staged rows than this pass's remaining budget allowed. Resolve this precisely
    // (not by heuristic) via the same read-only listing dry-run already uses, rather than guessing.
    if (budgetBeforeThisCandidate > 0 && result.deletedPhotos.length === budgetBeforeThisCandidate) {
      try {
        const remainingForCandidate = await deps.listStagedPhotosByIntake(candidate.id);
        if (remainingForCandidate.length > 0) counters.truncated = true;
      } catch {
        // Cannot confirm the backlog is gone - fail safe by flagging possible truncation rather
        // than silently under-reporting it.
        counters.truncated = true;
      }
    }

    // Post-commit, per-photo, independently isolated file cleanup - the DB deletion has already
    // committed by the time any of this runs, matching the DB-first rule exactly.
    for (const photo of result.deletedPhotos) {
      try {
        const disposition = await deps.deletePrivateFile(photo.storageKey);
        if (disposition === "regular_file") counters.stagedFilesDeleted += 1;
        else if (disposition === "already_absent") counters.stagedFilesAlreadyAbsent += 1;
        else counters.failures += 1;
      } catch {
        counters.failures += 1;
      }
    }
  }
}

async function sweepPrivateOrphans(
  deps: AiIntakeCleanupUseCaseDeps,
  input: AiIntakeCleanupInput,
  effectiveDryRun: boolean,
  counters: ReturnType<typeof emptyCounters>,
): Promise<void> {
  const walk = await deps.walkPrivateRoot({
    maxExamine: input.maxExaminedEntriesPerRoot,
    timeBudgetMs: input.scanTimeBudgetMsPerRoot,
    now: () => input.now.getTime(),
  });
  counters.truncated = counters.truncated || walk.truncated;

  let remainingBudget = input.batchSize;
  for (const entry of walk.entries) {
    counters.filesExamined += 1;

    if (!isPrivateStagedFilename(entry.name)) { counters.unknownFilesRetained += 1; continue; }
    if (entry.disposition === "symlink") { counters.symlinksRetained += 1; continue; }
    if (entry.disposition === "directory" || entry.disposition === "other_non_regular") { counters.directoriesRetained += 1; continue; }
    if (entry.disposition === "already_absent") continue;
    if (entry.disposition === "unsafe_path") { counters.failures += 1; continue; }

    const owned = await deps.repository.existsStagedPhotoByStorageKey(entry.name);
    if (owned) { counters.activeSourceRowsRetained += 1; continue; }

    if (!isAgeAndWatermarkEligible(entry.mtimeMs, input.now, input.processStartedAt, input.orphanGraceMs)) {
      counters.ageProtected += 1;
      continue;
    }

    counters.privateOrphansEligible += 1;
    if (effectiveDryRun || remainingBudget <= 0) continue;
    try {
      const disposition = await deps.deletePrivateFile(entry.name);
      if (disposition === "regular_file") { counters.privateOrphansDeleted += 1; remainingBudget -= 1; }
      else if (disposition !== "already_absent") counters.failures += 1;
    } catch {
      counters.failures += 1;
    }
  }

  // Both counters reflect the full, uncapped census of this walk (Eligible increments
  // unconditionally, before any dry-run/budget gate) - in execute mode, more eligible than
  // deleted means the action budget, not the scan, is why destructive work is incomplete.
  if (!effectiveDryRun && counters.privateOrphansEligible > counters.privateOrphansDeleted) {
    counters.truncated = true;
  }
}

async function sweepCanonicalOrphans(
  deps: AiIntakeCleanupUseCaseDeps,
  input: AiIntakeCleanupInput,
  effectiveDryRun: boolean,
  counters: ReturnType<typeof emptyCounters>,
): Promise<void> {
  const walk = await deps.walkCanonicalRoot({
    maxExamine: input.maxExaminedEntriesPerRoot,
    timeBudgetMs: input.scanTimeBudgetMsPerRoot,
    now: () => input.now.getTime(),
  });
  counters.truncated = counters.truncated || walk.truncated;

  let remainingBudget = input.batchSize;
  for (const entry of walk.entries) {
    counters.filesExamined += 1;

    const parsed = parseCanonicalFilename(entry.name);
    if (!parsed) { counters.unknownFilesRetained += 1; continue; }
    if (entry.disposition === "symlink") { counters.symlinksRetained += 1; continue; }
    if (entry.disposition === "directory" || entry.disposition === "other_non_regular") { counters.directoriesRetained += 1; continue; }
    if (entry.disposition === "already_absent") continue;
    if (entry.disposition === "unsafe_path") { counters.failures += 1; continue; }

    // Mandatory, unconditional, checked first: a live staged source row proves a legitimate
    // Sprint 95 finalization retry remains possible for this exact deterministic identity,
    // regardless of the owning intake's status or this file's age.
    const hasStagedRow = await deps.repository.existsStagedPhotoById(parsed.photoId);
    if (hasStagedRow) { counters.activeSourceRowsRetained += 1; continue; }

    const hasProductPhotoRow = await deps.repository.existsProductPhotoByIdAndProductId(parsed.photoId, parsed.productId);
    if (hasProductPhotoRow) { counters.liveFilesRetained += 1; continue; }

    const hasActiveOutbox = await deps.repository.hasNonTerminalProductPhotoOutboxEvent(parsed.photoId);
    if (hasActiveOutbox) { counters.activeOutboxRetained += 1; continue; }

    if (!isAgeAndWatermarkEligible(entry.mtimeMs, input.now, input.processStartedAt, input.orphanGraceMs)) {
      counters.ageProtected += 1;
      continue;
    }

    counters.canonicalOrphansEligible += 1;
    if (effectiveDryRun || remainingBudget <= 0) continue;
    try {
      const disposition = await deps.deleteCanonicalFile(entry.name);
      if (disposition === "regular_file") { counters.canonicalOrphansDeleted += 1; remainingBudget -= 1; }
      else if (disposition !== "already_absent") counters.failures += 1;
    } catch {
      counters.failures += 1;
    }
  }

  // Same reasoning as sweepPrivateOrphans: Eligible is a full, uncapped census; in execute mode
  // more eligible than deleted means the action budget cut off destructive work early.
  if (!effectiveDryRun && counters.canonicalOrphansEligible > counters.canonicalOrphansDeleted) {
    counters.truncated = true;
  }
}

/**
 * Sprint 96: the single narrow cleanup use case - owns retention-cutoff
 * computation, candidate classification, dry-run/execute behavior, batch
 * budgets, result-counter aggregation, and per-item failure isolation.
 * Never executes raw SQL/Drizzle directly (delegates every DB read/write to
 * the injected repository) and never touches the filesystem directly
 * (delegates every fs operation to the injected walk/delete functions).
 *
 * `effectiveDryRun` is computed here, never trusted from the caller alone:
 * whenever executionEnabled is false, this run behaves exactly as a dry-run
 * regardless of what input.dryRun says, and the returned result always
 * reports dryRun:true in that case - a forcibly non-destructive run is never
 * reported as dryRun:false. By construction, services/aiIntakeCleanup.ts
 * never actually invokes this function with {dryRun:false,
 * executionEnabled:false} (the Admin route rejects that combination before
 * calling it, and the scheduler path returns emptyDisabledCleanupResult()
 * without calling it at all) - this is still enforced here as a second,
 * independent safety layer, never assumed from the caller's discipline alone.
 */
export async function runAiIntakeCleanupUseCase(deps: AiIntakeCleanupUseCaseDeps, input: AiIntakeCleanupInput): Promise<AiIntakeCleanupResult> {
  const startedAtMs = Date.now();
  const effectiveDryRun = input.dryRun || !input.executionEnabled;
  const counters = emptyCounters();

  const cancelledCutoff = new Date(input.now.getTime() - input.cancelledStagedRetentionMs).toISOString();
  const finalizedCutoff = new Date(input.now.getTime() - input.finalizedStagedRetentionMs).toISOString();

  await cleanStagedRetention(deps, input, effectiveDryRun, { cancelledCutoff, finalizedCutoff }, counters);
  await sweepPrivateOrphans(deps, input, effectiveDryRun, counters);
  await sweepCanonicalOrphans(deps, input, effectiveDryRun, counters);

  return {
    executionEnabled: input.executionEnabled,
    dryRun: effectiveDryRun,
    ...counters,
    durationMs: Date.now() - startedAtMs,
  };
}
