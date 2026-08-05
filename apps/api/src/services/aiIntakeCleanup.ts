import type { DbClient } from "../db/client";
import { AiIntakeCleanupConfigurationInvalidError, AiIntakeCleanupExecutionDisabledError } from "./errors";
import { createAiIntakeCleanupRepository } from "../repositories/ai-intake-cleanup/factory";
import { createAiIntakePhotoRepository } from "../repositories/ai-intake-photo/factory";
import { aiIntakePhotoStagingRoot } from "./aiIntakePhotoStorage";
import { productPhotoStaticRoot } from "./photoStorage";
import { deleteManagedFile, walkManagedDirectory } from "./managedFileDeletion";
import {
  emptyDisabledCleanupResult,
  runAiIntakeCleanupUseCase,
  type AiIntakeCleanupInput,
  type AiIntakeCleanupResult,
  type AiIntakeCleanupUseCaseDeps,
} from "../use-cases/ai-intake-cleanup/useCases";

/**
 * Sprint 96: the narrow cleanup service - owns configuration loading/
 * validation, repository/storage dependency construction, use-case
 * invocation, and result translation. Never executes raw SQL or Drizzle
 * queries directly (all DB access is delegated to the injected repository,
 * constructed here but never queried here).
 */

export const DEFAULT_CANCELLED_STAGED_RETENTION_MS = 2592000000; // 30 days
export const DEFAULT_FINALIZED_STAGED_RETENTION_MS = 7776000000; // 90 days
export const DEFAULT_ORPHAN_GRACE_MS = 604800000; // 7 days

export const DEFAULT_CLEANUP_BATCH_SIZE = 100;
export const MAX_CLEANUP_BATCH_SIZE = 500;

/**
 * Code-owned operational safety constants for the directory walk - never
 * environment-configured (matching PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS's
 * established precedent of a named, hardcoded, non-env constant for this
 * class of "how much is too much for one pass" threshold).
 */
const MAX_EXAMINED_ENTRIES_PER_ROOT = 100_000;
const SCAN_TIME_BUDGET_MS_PER_ROOT = 10_000;

/**
 * Captured exactly once, at module load (effectively server boot) - never
 * recalculated per request. A file written after this process started is
 * never eligible for automatic deletion, regardless of how the grace period
 * is configured (see the use case's isAgeAndWatermarkEligible).
 */
const processStartedAtWatermark = new Date();

/** Strict boolean parsing - reuses db/config.ts's exact established `=== "true"` convention. Anything other than the literal string "true" is false. */
function parseExecutionEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.AI_INTAKE_CLEANUP_EXECUTION_ENABLED ?? "false") === "true";
}

/**
 * Fails closed: an unset or explicitly-empty value uses the safe default
 * (an empty env var is treated the same as an absent one - a documented,
 * tested choice, not left ambiguous); any other value must parse to a
 * finite, positive number or this throws immediately, before any DB or
 * filesystem work has occurred. Never silently substitutes 0 or NaN, which
 * would make every candidate immediately eligible for destructive cleanup.
 */
function parsePositiveDurationMs(env: NodeJS.ProcessEnv, name: string, defaultMs: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AiIntakeCleanupConfigurationInvalidError(`Invalid ${name}: expected a positive finite number of milliseconds, got "${raw}"`);
  }
  return parsed;
}

function resolveBatchSize(requested: number | undefined): number {
  const candidate = requested ?? DEFAULT_CLEANUP_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(candidate), 1), MAX_CLEANUP_BATCH_SIZE);
}

/**
 * Validates the three retention/grace duration values without performing any
 * DB, repository, or filesystem work. Used by the disabled-scheduler path so
 * malformed configuration is still surfaced (as AiIntakeCleanupConfigurationInvalidError)
 * even while execution is disabled, instead of sitting silently undetected.
 */
function validateDurationConfig(env: NodeJS.ProcessEnv): void {
  parsePositiveDurationMs(env, "AI_INTAKE_CANCELLED_STAGED_RETENTION_MS", DEFAULT_CANCELLED_STAGED_RETENTION_MS);
  parsePositiveDurationMs(env, "AI_INTAKE_FINALIZED_STAGED_RETENTION_MS", DEFAULT_FINALIZED_STAGED_RETENTION_MS);
  parsePositiveDurationMs(env, "AI_INTAKE_ORPHAN_GRACE_MS", DEFAULT_ORPHAN_GRACE_MS);
}

function repositoryFor(db: DbClient) {
  const driver = (process.env.DATABASE_DRIVER as string) || "sqlite";
  return {
    cleanup: createAiIntakeCleanupRepository(driver, db),
    photos: createAiIntakePhotoRepository(driver, db),
  };
}

function buildDefaultDeps(db: DbClient): AiIntakeCleanupUseCaseDeps {
  const { cleanup, photos } = repositoryFor(db);
  return {
    repository: cleanup,
    listStagedPhotosByIntake: async (intakeId) => {
      const rows = await photos.listByIntake(intakeId);
      return rows.map((row) => ({ id: row.id as string, storageKey: row.storageKey as string }));
    },
    walkPrivateRoot: (options) => walkManagedDirectory(aiIntakePhotoStagingRoot, options),
    walkCanonicalRoot: (options) => walkManagedDirectory(productPhotoStaticRoot, options),
    deletePrivateFile: (key) => deleteManagedFile(aiIntakePhotoStagingRoot, key),
    deleteCanonicalFile: (key) => deleteManagedFile(productPhotoStaticRoot, key),
  };
}

export interface AiIntakeCleanupServiceOverrides {
  /** Test-only: substitutes process.env for config parsing. */
  env?: NodeJS.ProcessEnv;
  /** Test-only: a fixed "now" - production always uses the real current time per invocation. */
  now?: Date;
  /** Test-only: substitutes the stable process-start watermark. */
  processStartedAt?: Date;
  /** Test-only: substitutes the real repository/filesystem dependencies (e.g. with isolated mkdtemp roots, or a fully in-memory fake). */
  deps?: AiIntakeCleanupUseCaseDeps;
}

function buildInput(
  overrides: AiIntakeCleanupServiceOverrides,
  fixed: { dryRun: boolean; executionEnabled: boolean; batchSize: number },
): AiIntakeCleanupInput {
  const env = overrides.env ?? process.env;
  return {
    dryRun: fixed.dryRun,
    executionEnabled: fixed.executionEnabled,
    batchSize: fixed.batchSize,
    now: overrides.now ?? new Date(),
    processStartedAt: overrides.processStartedAt ?? processStartedAtWatermark,
    cancelledStagedRetentionMs: parsePositiveDurationMs(env, "AI_INTAKE_CANCELLED_STAGED_RETENTION_MS", DEFAULT_CANCELLED_STAGED_RETENTION_MS),
    finalizedStagedRetentionMs: parsePositiveDurationMs(env, "AI_INTAKE_FINALIZED_STAGED_RETENTION_MS", DEFAULT_FINALIZED_STAGED_RETENTION_MS),
    orphanGraceMs: parsePositiveDurationMs(env, "AI_INTAKE_ORPHAN_GRACE_MS", DEFAULT_ORPHAN_GRACE_MS),
    maxExaminedEntriesPerRoot: MAX_EXAMINED_ENTRIES_PER_ROOT,
    scanTimeBudgetMsPerRoot: SCAN_TIME_BUDGET_MS_PER_ROOT,
  };
}

/**
 * Sprint 96: the Admin dry-run/execute entry point. dryRun:true always
 * performs a full scan/classification regardless of executionEnabled (the
 * dry-run census the approved rollout plan requires). dryRun:false while
 * execution is disabled fails closed with AiIntakeCleanupExecutionDisabledError
 * BEFORE any configuration parsing, repository construction, or use-case
 * invocation - never a silent downgrade to a dry-run, never a silent no-op
 * reported as success.
 */
export async function runAiIntakeCleanupForAdmin(
  db: DbClient,
  options: { dryRun: boolean; batchSize?: number },
  overrides: AiIntakeCleanupServiceOverrides = {},
): Promise<AiIntakeCleanupResult> {
  const env = overrides.env ?? process.env;
  const executionEnabled = parseExecutionEnabled(env);
  if (!options.dryRun && !executionEnabled) {
    throw new AiIntakeCleanupExecutionDisabledError();
  }
  const input = buildInput(overrides, { dryRun: options.dryRun, executionEnabled, batchSize: resolveBatchSize(options.batchSize) });
  const deps = overrides.deps ?? buildDefaultDeps(db);
  return runAiIntakeCleanupUseCase(deps, input);
}

/**
 * Sprint 96: the scheduler entry point (called from POST /api/background-jobs/run).
 * Always intends real execution. When AI_INTAKE_CLEANUP_EXECUTION_ENABLED is
 * false, still validates the three duration configuration values (so a
 * malformed value is surfaced on the very next scheduled tick rather than
 * sitting silently undetected while disabled), then returns
 * emptyDisabledCleanupResult() - no repository construction, no directory
 * scan, no retention-candidate query. This is the literal "skipped without
 * scanning roots or querying candidates" behavior the approved architecture
 * requires; only pure configuration parsing occurs on the disabled path.
 */
export async function runAiIntakeCleanupForScheduler(
  db: DbClient,
  options: { batchSize?: number },
  overrides: AiIntakeCleanupServiceOverrides = {},
): Promise<AiIntakeCleanupResult> {
  const env = overrides.env ?? process.env;
  const executionEnabled = parseExecutionEnabled(env);
  if (!executionEnabled) {
    validateDurationConfig(env);
    return emptyDisabledCleanupResult();
  }

  const input = buildInput(overrides, { dryRun: false, executionEnabled, batchSize: resolveBatchSize(options.batchSize) });
  const deps = overrides.deps ?? buildDefaultDeps(db);
  return runAiIntakeCleanupUseCase(deps, input);
}
