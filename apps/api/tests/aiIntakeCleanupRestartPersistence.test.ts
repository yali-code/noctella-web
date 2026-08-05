// Sprint 96: AI intake cleanup restart persistence - mirrors
// aiIntakePhotoFinalizeRestartPersistence.test.ts's established two-independent-runtimes-over-
// the-same-file technique. A real file-backed SQLite database and real filesystem roots, all in
// temporary directories outside the repository, all removed after the test (even on assertion
// failure, via afterAll). Proves: an orphan left behind by a post-commit cleanup failure survives
// a full process restart; a later cleanup pass (against a brand-new runtime, never reusing the
// first run's in-memory objects) removes it; and a live, still-owned staged photo survives restart
// untouched.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

const dbTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-sprint96-restart-db-"));
const stagedPhotoTempDir = mkdtempSync(path.join(os.tmpdir(), "noctella-sprint96-restart-staged-"));
process.env.AI_INTAKE_PHOTO_DIR = stagedPhotoTempDir;

afterAll(() => {
  rmSync(dbTempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(stagedPhotoTempDir, { recursive: true, force: true });
});

describe("Sprint 96: AI intake cleanup restart persistence", () => {
  it("an orphan left by a post-commit cleanup failure survives restart, a later run (fresh runtime) removes it, and a live staged photo survives restart untouched", async () => {
    const dbFile = path.join(dbTempDir, "sprint96-restart-test.sqlite");
    const { createDatabaseRuntime } = await import("../src/db/runtime");
    const env = { DATABASE_DRIVER: "sqlite", DATABASE_URL: dbFile } as unknown as NodeJS.ProcessEnv;

    const { createIntake, cancelIntake } = await import("../src/services/aiProductIntakes");
    const { uploadIntakePhoto, listIntakePhotos } = await import("../src/services/aiIntakePhotos");
    const { LocalAiIntakePhotoStorage } = await import("../src/services/aiIntakePhotoStorage");
    const { runAiIntakeCleanupUseCase, isPrivateStagedFilename } = await import("../src/use-cases/ai-intake-cleanup/useCases");
    const { createAiIntakeCleanupRepository } = await import("../src/repositories/ai-intake-cleanup/factory");
    const { createAiIntakePhotoRepository } = await import("../src/repositories/ai-intake-photo/factory");
    const { walkManagedDirectory, deleteManagedFile } = await import("../src/services/managedFileDeletion");

    // Sprint 96 correction pass (final hardening): both runtimes are tracked in outer-scoped
    // variables with a per-runtime "already closed" flag, and closed via one outer try/finally -
    // so a thrown assertion (or a timeout abandoning the test mid-flight) can never skip shutting
    // down whichever runtime(s) are still open, regardless of exactly where execution stopped. The
    // flag is set BEFORE calling shutdown() (not after), so a shutdown() call that itself throws is
    // never attempted a second time from the finally block. Each finally-block close is
    // best-effort (`.catch(() => {})`) specifically so a secondary cleanup failure can never mask
    // the primary test failure/error that triggered the finally in the first place - it does not
    // hide a cleanup problem, it only prevents a cleanup problem from overwriting a more important
    // one that already happened.
    let first: Awaited<ReturnType<typeof createDatabaseRuntime>> | undefined;
    let second: Awaited<ReturnType<typeof createDatabaseRuntime>> | undefined;
    let firstClosed = false;
    let secondClosed = false;

    async function closeFirst() {
      if (first && !firstClosed) {
        firstClosed = true;
        await first.shutdown();
      }
    }
    async function closeSecond() {
      if (second && !secondClosed) {
        secondClosed = true;
        await second.shutdown();
      }
    }

    try {
      // ---- "first process run": create + stage a photo on a live (Open) intake, plus a second
      // intake that will be cancelled and aged past retention, so its post-commit file cleanup can
      // be made to fail (simulating a crash/failure right after the DB commit) ----
      first = createDatabaseRuntime(env);
      const dbFirst = first.db as any;
      const storage = new LocalAiIntakePhotoStorage(stagedPhotoTempDir);

      const liveBuffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
      const orphanBuffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).png().toBuffer();

      const liveIntake = await createIntake(dbFirst, "admin-1");
      const livePhoto = await uploadIntakePhoto(dbFirst, liveIntake.id, { buffer: liveBuffer, mimetype: "image/png", size: liveBuffer.length }, "live.png", "admin-1", storage);
      expect(isPrivateStagedFilename(livePhoto.storageKey)).toBe(true);

      const cancelledIntake = await createIntake(dbFirst, "admin-1");
      const orphanPhoto = await uploadIntakePhoto(dbFirst, cancelledIntake.id, { buffer: orphanBuffer, mimetype: "image/png", size: orphanBuffer.length }, "orphan.png", "admin-1", storage);
      await cancelIntake(dbFirst, cancelledIntake.id, "admin-2");
      expect(existsSync(path.join(stagedPhotoTempDir, orphanPhoto.storageKey))).toBe(true);

      // Run the real, bounded retention-cleanup use case directly (not the HTTP layer) against the
      // first runtime, with a deliberately failing deletePrivateFile - simulating a crash/failure
      // during the post-commit file-delete step, right after the DB row has already committed gone.
      const cleanupRepoFirst = createAiIntakeCleanupRepository("sqlite", dbFirst);
      const photoRepoFirst = createAiIntakePhotoRepository("sqlite", dbFirst);
      const now = new Date(Date.now() + 1000);
      await runAiIntakeCleanupUseCase(
        {
          repository: cleanupRepoFirst,
          listStagedPhotosByIntake: async (id) => (await photoRepoFirst.listByIntake(id)).map((r: any) => ({ id: r.id, storageKey: r.storageKey })),
          walkPrivateRoot: (o) => walkManagedDirectory(stagedPhotoTempDir, o),
          walkCanonicalRoot: async () => ({ entries: [], truncated: false }),
          deletePrivateFile: async () => { throw new Error("simulated crash during post-commit file cleanup"); },
          deleteCanonicalFile: async () => "already_absent",
        },
        {
          dryRun: false,
          batchSize: 100,
          executionEnabled: true,
          now,
          processStartedAt: new Date(0),
          cancelledStagedRetentionMs: 1,
          finalizedStagedRetentionMs: 1,
          orphanGraceMs: 1,
          maxExaminedEntriesPerRoot: 1000,
          scanTimeBudgetMsPerRoot: 10_000,
        },
      );

      // DB row is gone (the "crash" happened after commit), but the file remains - the accepted,
      // explicitly-owned Sprint 96 residual state.
      expect(await listIntakePhotos(dbFirst, cancelledIntake.id)).toHaveLength(0);
      expect(existsSync(path.join(stagedPhotoTempDir, orphanPhoto.storageKey))).toBe(true);
      // The live intake's staged photo is completely untouched.
      expect(existsSync(path.join(stagedPhotoTempDir, livePhoto.storageKey))).toBe(true);
      expect(await listIntakePhotos(dbFirst, liveIntake.id)).toHaveLength(1);

      // The first runtime is fully closed BEFORE the second runtime opens the same file-backed
      // database - preserving the genuine "two independent runtimes, never overlapping" proof.
      await closeFirst();

      // ---- "second process run": reopen the DB connection, reconstruct every repository/service
      // fresh, against the same underlying files - never reusing the first run's in-memory objects ----
      second = createDatabaseRuntime(env);
      const dbSecond = second.db as any;

      // The orphan file survived the restart exactly as left.
      expect(existsSync(path.join(stagedPhotoTempDir, orphanPhoto.storageKey))).toBe(true);
      expect(await listIntakePhotos(dbSecond, cancelledIntake.id)).toHaveLength(0);
      // The live staged photo also survived the restart, completely unaffected.
      expect(existsSync(path.join(stagedPhotoTempDir, livePhoto.storageKey))).toBe(true);
      const liveAfterRestart = await listIntakePhotos(dbSecond, liveIntake.id);
      expect(liveAfterRestart).toHaveLength(1);
      expect(liveAfterRestart[0].id).toBe(livePhoto.id);

      // A later cleanup pass, against the fresh second runtime, with a real (non-throwing)
      // deletePrivateFile this time, removes the residual orphan - and still leaves the live photo
      // completely untouched.
      const cleanupRepoSecond = createAiIntakeCleanupRepository("sqlite", dbSecond);
      const photoRepoSecond = createAiIntakePhotoRepository("sqlite", dbSecond);
      const later = new Date(now.getTime() + 100_000);
      const result = await runAiIntakeCleanupUseCase(
        {
          repository: cleanupRepoSecond,
          listStagedPhotosByIntake: async (id) => (await photoRepoSecond.listByIntake(id)).map((r: any) => ({ id: r.id, storageKey: r.storageKey })),
          walkPrivateRoot: (o) => walkManagedDirectory(stagedPhotoTempDir, o),
          walkCanonicalRoot: async () => ({ entries: [], truncated: false }),
          deletePrivateFile: (key) => deleteManagedFile(stagedPhotoTempDir, key),
          deleteCanonicalFile: async () => "already_absent",
        },
        {
          dryRun: false,
          batchSize: 100,
          executionEnabled: true,
          now: later,
          // Anchored to the first run's timestamp (`now`, already safely after the real file writes
          // above) rather than epoch - the orphan file's real mtime must predate this watermark for
          // it to become eligible, matching the same reasoning established in aiIntakeCleanup.test.ts.
          processStartedAt: now,
          cancelledStagedRetentionMs: 1,
          finalizedStagedRetentionMs: 1,
          orphanGraceMs: 1,
          maxExaminedEntriesPerRoot: 1000,
          scanTimeBudgetMsPerRoot: 10_000,
        },
      );

      expect(result.privateOrphansDeleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(path.join(stagedPhotoTempDir, orphanPhoto.storageKey))).toBe(false);
      // The live photo's file is still present and its row still owns it - never touched by any
      // cleanup pass, across either runtime.
      expect(existsSync(path.join(stagedPhotoTempDir, livePhoto.storageKey))).toBe(true);
      expect(await listIntakePhotos(dbSecond, liveIntake.id)).toHaveLength(1);

      await closeSecond();
    } finally {
      // Best-effort: if either runtime was left open by a thrown assertion (or the test being
      // abandoned mid-flight on timeout), close it now so the temp-directory removal in afterAll
      // never races a still-open better-sqlite3 file handle. Never closes an already-closed runtime
      // (guarded by the flags above) and never lets a cleanup failure here replace/mask whatever
      // error actually caused this finally block to run.
      await closeFirst().catch(() => {});
      await closeSecond().catch(() => {});
    }
  }, 30_000);
});
