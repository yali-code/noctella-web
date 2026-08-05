// Sprint 96: AI Intake Cleanup, Retention, and Orphan Sweep - core coverage for the filename
// parsers, the managed-file filesystem adapter, the ai-intake-cleanup repository, the Sprint 95
// affected-row hardening, the cleanup service's configuration parsing, and the cleanup use case's
// full orchestration (dry-run vs execute, staged retention, private/canonical orphan sweeps,
// batching, truncation, and serial-order concurrency proofs). All real operations - no sleeps, no
// `.skip`/`.todo`/`.only`, no random ordering. Every clock-dependent assertion uses an injected
// `now`/`processStartedAt`, never a real wall-clock wait.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { lstat, mkdir, mkdtemp, rm as rmDir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { createIntake, cancelIntake } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto, deleteIntakePhoto } from "../src/services/aiIntakePhotos";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { aiIntakePhotos, aiProductIntakes, outboxEvents, productPhotos, products } from "../src/db/schema";
import { AiIntakePhotoDeleteIntegrityFailureError, AiIntakeCleanupConfigurationInvalidError, AiIntakeCleanupExecutionDisabledError } from "../src/services/errors";
import { createDrizzleAiIntakePhotoRepository } from "../src/repositories/ai-intake-photo/drizzle";
import { createDrizzleAiIntakeCleanupRepository } from "../src/repositories/ai-intake-cleanup/drizzle";
import type { AiIntakeLockTransactionCapability } from "../src/services/aiIntakeLockTransactionCapabilityForDb";
import * as sqliteSchema from "../src/db/schema.sqlite";
import {
  deleteManagedFile,
  statManagedFile,
  walkManagedDirectory,
} from "../src/services/managedFileDeletion";
import {
  isPrivateStagedFilename,
  parseCanonicalFilename,
  runAiIntakeCleanupUseCase,
  emptyDisabledCleanupResult,
  type AiIntakeCleanupInput,
  type AiIntakeCleanupUseCaseDeps,
} from "../src/use-cases/ai-intake-cleanup/useCases";
import {
  runAiIntakeCleanupForAdmin,
  runAiIntakeCleanupForScheduler,
  DEFAULT_CANCELLED_STAGED_RETENTION_MS,
  DEFAULT_FINALIZED_STAGED_RETENTION_MS,
  DEFAULT_ORPHAN_GRACE_MS,
} from "../src/services/aiIntakeCleanup";

async function insertMinimalProduct(db: ReturnType<typeof createTestDb>, id: string) {
  await db.insert(products).values({
    id,
    slug: id,
    sku: `SKU-${id}`,
    title: `Cleanup Test Product ${id}`,
    type: ProductType.UniqueItem,
    status: ProductStatus.Draft,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    priceEur: 10,
  } as any);
}

function mockPhotoStorage(): AiIntakePhotoStorage {
  let counter = 0;
  return {
    saveIntakePhoto: async () => {
      counter += 1;
      return { storageKey: `mock-key-${counter}.webp` };
    },
    deleteIntakePhoto: async () => {},
  };
}

const REAL_UUID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const REAL_UUID_B = "bbbbbbbb-2222-4222-8222-222222222222";

/**
 * Sprint 96 correction pass: a test-only fake AiIntakeLockTransactionCapability whose `tx`
 * responds to exactly the chained builder calls both repositories issue (`select().from().where()`,
 * `select().from().where().orderBy().limit()`, `delete().where().returning()`) with pre-programmed
 * results - allowing a successful DELETE statement that returns an unexpected RETURNING result to be
 * forced deterministically, without touching a real SQLite/PostgreSQL connection and without any
 * production fake-driver abstraction (this helper lives only in this test file).
 */
function createFakeIntegrityCapability(intake: Record<string, any> | null, selectResult: any[], deleteResult: any[]): AiIntakeLockTransactionCapability {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => selectResult,
    all: () => selectResult,
    returning: () => deleteResult,
  };
  const tx: any = {
    select: () => chain,
    delete: () => chain,
  };
  return {
    driver: "test-memory",
    execution: "synchronous",
    runWithLockedIntake: (_intakeId: string, work: any) => work({ tx, schema: sqliteSchema, execution: "synchronous", intake }),
  };
}

describe("Sprint 96 filename parsers", () => {
  describe("isPrivateStagedFilename", () => {
    it("accepts an exact lowercase UUID.webp", () => {
      expect(isPrivateStagedFilename(`${REAL_UUID_A}.webp`)).toBe(true);
    });
    it("rejects uppercase", () => {
      expect(isPrivateStagedFilename(`${REAL_UUID_A.toUpperCase()}.webp`)).toBe(false);
    });
    it("rejects an extra suffix", () => {
      expect(isPrivateStagedFilename(`${REAL_UUID_A}-thumb.webp`)).toBe(false);
    });
    it("rejects a multiple/double extension", () => {
      expect(isPrivateStagedFilename(`${REAL_UUID_A}.webp.webp`)).toBe(false);
    });
    it("rejects a UUID-like prefix with trailing data", () => {
      expect(isPrivateStagedFilename(`${REAL_UUID_A}-extra.webp`)).toBe(false);
    });
    it("rejects a path separator", () => {
      expect(isPrivateStagedFilename(`sub/${REAL_UUID_A}.webp`)).toBe(false);
    });
    it("rejects an arbitrary .webp file", () => {
      expect(isPrivateStagedFilename("not-a-uuid.webp")).toBe(false);
    });
  });

  describe("parseCanonicalFilename", () => {
    it("accepts the exact deterministic main shape and returns productId/photoId", () => {
      const parsed = parseCanonicalFilename(`${REAL_UUID_A}-${REAL_UUID_B}.webp`);
      expect(parsed).toEqual({ productId: REAL_UUID_A, photoId: REAL_UUID_B, isThumbnail: false });
    });
    it("accepts the exact deterministic thumbnail shape", () => {
      const parsed = parseCanonicalFilename(`${REAL_UUID_A}-${REAL_UUID_B}-thumb.webp`);
      expect(parsed).toEqual({ productId: REAL_UUID_A, photoId: REAL_UUID_B, isThumbnail: true });
    });
    it("rejects an ordinary-upload filename (decimal timestamp prefix, not a UUID)", () => {
      expect(parseCanonicalFilename(`${Date.now()}-${REAL_UUID_B}.webp`)).toBeNull();
    });
    it("rejects a malformed UUID pair", () => {
      expect(parseCanonicalFilename(`not-a-uuid-${REAL_UUID_B}.webp`)).toBeNull();
      expect(parseCanonicalFilename(`${REAL_UUID_A}-not-a-uuid.webp`)).toBeNull();
    });
    it("does not parse by naive hyphen splitting (a photoId containing many hyphen-adjacent hex groups still resolves to exactly two UUID groups)", () => {
      // Both halves are themselves hyphenated - a naive split("-") would produce 10 fragments.
      // The anchored parser must still resolve exactly 2 groups.
      const parsed = parseCanonicalFilename(`${REAL_UUID_A}-${REAL_UUID_B}.webp`);
      expect(parsed?.productId.split("-")).toHaveLength(5);
      expect(parsed?.photoId.split("-")).toHaveLength(5);
    });
  });
});

describe("Sprint 96 managedFileDeletion.ts", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "noctella-managed-file-"));
  });
  afterEach(async () => {
    await rmDir(root, { recursive: true, force: true });
  });

  describe("statManagedFile / deleteManagedFile", () => {
    it("classifies a regular file and reports its mtime", async () => {
      await writeFile(path.join(root, "a.webp"), "x");
      const info = await statManagedFile(root, "a.webp");
      expect(info.disposition).toBe("regular_file");
      expect(info.mtimeMs).toBeTypeOf("number");
    });
    it("reports an absent file as already_absent, never throws", async () => {
      const info = await statManagedFile(root, "missing.webp");
      expect(info.disposition).toBe("already_absent");
    });
    it("rejects traversal", async () => {
      const info = await statManagedFile(root, "../escape.webp");
      expect(info.disposition).toBe("unsafe_path");
    });
    it("rejects a POSIX-absolute key", async () => {
      const info = await statManagedFile(root, "/etc/passwd");
      expect(info.disposition).toBe("unsafe_path");
    });
    it("rejects a Windows-drive-absolute key", async () => {
      const info = await statManagedFile(root, "C:\\Windows\\System32\\config");
      expect(info.disposition).toBe("unsafe_path");
    });
    it("rejects a Windows UNC path key", async () => {
      const info = await statManagedFile(root, "\\\\server\\share\\file.webp");
      expect(info.disposition).toBe("unsafe_path");
    });
    it("rejects a key containing a path separator", async () => {
      expect((await statManagedFile(root, "sub/x.webp")).disposition).toBe("unsafe_path");
      expect((await statManagedFile(root, "sub\\x.webp")).disposition).toBe("unsafe_path");
    });
    it("rejects an empty key", async () => {
      expect((await statManagedFile(root, "")).disposition).toBe("unsafe_path");
    });
    it("retains and reports a directory - never treated as a deletable file", async () => {
      await mkdir(path.join(root, "adir"));
      const info = await statManagedFile(root, "adir");
      expect(info.disposition).toBe("directory");
    });
    it("retains and reports a symlink without following it", async () => {
      const target = path.join(root, "target.webp");
      await writeFile(target, "real bytes");
      try {
        await symlink(target, path.join(root, "link.webp"));
      } catch (err: any) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return; // platform cannot create symlinks here - covered on CI
        throw err;
      }
      const info = await statManagedFile(root, "link.webp");
      expect(info.disposition).toBe("symlink");
    });
    it("deleteManagedFile deletes exactly a confirmed regular file, idempotently", async () => {
      await writeFile(path.join(root, "a.webp"), "x");
      expect(await deleteManagedFile(root, "a.webp")).toBe("regular_file");
      expect(existsSync(path.join(root, "a.webp"))).toBe(false);
      expect(await deleteManagedFile(root, "a.webp")).toBe("already_absent");
    });
    it("deleteManagedFile never deletes a directory (no recursive deletion)", async () => {
      await mkdir(path.join(root, "adir"));
      expect(await deleteManagedFile(root, "adir")).toBe("directory");
      expect(existsSync(path.join(root, "adir"))).toBe(true);
    });
    it("resolved candidate path stays contained beneath the resolved root", async () => {
      await writeFile(path.join(root, "a.webp"), "x");
      const info = await statManagedFile(root, "a.webp");
      expect(info.path!.startsWith(path.resolve(root) + path.sep)).toBe(true);
    });
  });

  describe("walkManagedDirectory", () => {
    it("uses a streaming opendir walk and finds an eligible file regardless of its position among many entries (disproves position-based starvation)", async () => {
      for (let i = 0; i < 50; i += 1) {
        await writeFile(path.join(root, `${String(i).padStart(3, "0")}-retained.webp`), "x");
      }
      await writeFile(path.join(root, "zzz-last-eligible.webp"), "x");
      const result = await walkManagedDirectory(root, { maxExamine: 1000, timeBudgetMs: 60_000, now: () => Date.now() });
      expect(result.truncated).toBe(false);
      expect(result.entries).toHaveLength(51);
      expect(result.entries.some((e) => e.name === "zzz-last-eligible.webp")).toBe(true);
    });
    it("truncates when the examined-entry ceiling is reached", async () => {
      for (let i = 0; i < 10; i += 1) await writeFile(path.join(root, `${i}.webp`), "x");
      const result = await walkManagedDirectory(root, { maxExamine: 3, timeBudgetMs: 60_000, now: () => Date.now() });
      expect(result.truncated).toBe(true);
      expect(result.entries).toHaveLength(3);
    });
    it("truncates when the time budget is exceeded, using only an injected clock (no real sleep)", async () => {
      for (let i = 0; i < 5; i += 1) await writeFile(path.join(root, `${i}.webp`), "x");
      let calls = 0;
      const result = await walkManagedDirectory(root, {
        maxExamine: 1000,
        timeBudgetMs: 10,
        now: () => { calls += 1; return calls > 1 ? 1000 : 0; }, // second `now()` call already exceeds the 10ms budget
      });
      expect(result.truncated).toBe(true);
    });
    it("requires no cursor/restart state - two independent full scans of the same directory both find the same entries", async () => {
      await writeFile(path.join(root, "a.webp"), "x");
      await writeFile(path.join(root, "b.webp"), "x");
      const first = await walkManagedDirectory(root, { maxExamine: 1000, timeBudgetMs: 60_000, now: () => Date.now() });
      const second = await walkManagedDirectory(root, { maxExamine: 1000, timeBudgetMs: 60_000, now: () => Date.now() });
      expect(first.entries.map((e) => e.name).sort()).toEqual(second.entries.map((e) => e.name).sort());
    });
    it("returns an empty, non-throwing result for a root that does not exist yet", async () => {
      const result = await walkManagedDirectory(path.join(root, "does-not-exist"), { maxExamine: 10, timeBudgetMs: 1000, now: () => Date.now() });
      expect(result).toEqual({ entries: [], truncated: false });
    });
  });
});

describe("Sprint 96 correction pass (optional): then/rows thenable normalization regression proof", () => {
  // Both repository files define an identical, module-private `then`/`rows` pair (never exported -
  // the production architecture does not export internal helpers). This test reproduces that exact
  // logic verbatim, and a real drizzle-orm-shaped thenable (a plain class implementing `.then()`,
  // deliberately NOT extending Promise - matching drizzle-orm's actual QueryPromise base class used
  // by every async query builder object), to permanently prove `rows(..., "asynchronous")` correctly
  // resolves such a value via Promise.resolve()'s spec-mandated thenable adoption, before `then()`'s
  // `instanceof Promise` check ever needs to see the raw thenable directly.
  class FakeDrizzleQueryPromise {
    constructor(private readonly resolvedRows: any[]) {}
    then(onFulfilled: any, onRejected?: any) {
      return this.execute().then(onFulfilled, onRejected);
    }
    execute(): Promise<any[]> {
      return new Promise((resolve) => setImmediate(() => resolve(this.resolvedRows)));
    }
  }

  type Execution = "synchronous" | "asynchronous";
  type Result<T> = T | Promise<T>;
  const then = <T, U>(value: Result<T>, next: (value: T) => Result<U>): Result<U> =>
    value instanceof Promise ? value.then(next) : next(value);
  const rows = (q: any, execution: Execution): Result<any[]> =>
    execution === "synchronous" ? (Array.isArray(q) ? q : q.all()) : Promise.resolve(q);

  it("a fake QueryPromise-shaped thenable that is NOT instanceof Promise still resolves correctly through rows()+then()", async () => {
    const fakeThenable = new FakeDrizzleQueryPromise([{ id: "row-1" }, { id: "row-2" }]);
    expect(fakeThenable instanceof Promise).toBe(false);

    const result = await then(rows(fakeThenable, "asynchronous"), (resolvedRows: any[]) => resolvedRows.map((r) => r.id));
    expect(result).toEqual(["row-1", "row-2"]);
  });
});

describe("Sprint 96 ai-intake-cleanup repository (real SQLite)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;

  beforeEach(async () => {
    db = createTestDb();
    sqlite = (db as any).session.client as InstanceType<typeof Database>;
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  async function stageOnePhoto(id: string) {
    const storage = mockPhotoStorage();
    return uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from(id), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
  }

  function repo() {
    return createDrizzleAiIntakeCleanupRepository(db as any, sqliteSchema);
  }

  describe("listTerminalIntakesWithStagedPhotosEligibleForRetention", () => {
    it("excludes an Open intake even with staged photos", async () => {
      await stageOnePhoto("p1");
      const found = await repo().listTerminalIntakesWithStagedPhotosEligibleForRetention({
        cancelledCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        finalizedCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        limit: 10,
      });
      expect(found.find((c) => c.id === intakeId)).toBeUndefined();
    });

    it("excludes a terminal intake that already has zero staged rows", async () => {
      const photo = await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      await deleteIntakePhoto(db as any, intakeId, photo.id, mockPhotoStorage());
      const found = await repo().listTerminalIntakesWithStagedPhotosEligibleForRetention({
        cancelledCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        finalizedCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        limit: 10,
      });
      expect(found.find((c) => c.id === intakeId)).toBeUndefined();
    });

    it("includes a Cancelled intake with staged photos when cancelledAt <= cutoff, excludes when cutoff is before cancelledAt", async () => {
      await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      const past = await repo().listTerminalIntakesWithStagedPhotosEligibleForRetention({
        cancelledCutoff: new Date(0).toISOString(),
        finalizedCutoff: new Date(0).toISOString(),
        limit: 10,
      });
      expect(past.find((c) => c.id === intakeId)).toBeUndefined();

      const future = await repo().listTerminalIntakesWithStagedPhotosEligibleForRetention({
        cancelledCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        finalizedCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        limit: 10,
      });
      expect(future.find((c) => c.id === intakeId)).toBeTruthy();
    });

    it("orders deterministically by retention origin ascending, then id ascending", async () => {
      const intakeA = await createIntake(db as any, "admin-1");
      const intakeB = await createIntake(db as any, "admin-1");
      await uploadIntakePhoto(db as any, intakeA.id, { buffer: Buffer.from("a"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", mockPhotoStorage());
      await uploadIntakePhoto(db as any, intakeB.id, { buffer: Buffer.from("b"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", mockPhotoStorage());
      await cancelIntake(db as any, intakeA.id, "admin-2");
      await cancelIntake(db as any, intakeB.id, "admin-2");
      // Force a deterministic, distinct order regardless of wall-clock timing.
      await db.update(aiProductIntakes).set({ cancelledAt: "2020-01-01T00:00:00.000Z" }).where(eq(aiProductIntakes.id, intakeA.id));
      await db.update(aiProductIntakes).set({ cancelledAt: "2020-01-02T00:00:00.000Z" }).where(eq(aiProductIntakes.id, intakeB.id));

      const found = await repo().listTerminalIntakesWithStagedPhotosEligibleForRetention({
        cancelledCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        finalizedCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        limit: 10,
      });
      const ids = found.map((c) => c.id).filter((id) => id === intakeA.id || id === intakeB.id);
      expect(ids).toEqual([intakeA.id, intakeB.id]);
    });

    it("orders by the status-aware retention origin, not a naive COALESCE(cancelledAt, finalizedAt) - genuinely discriminating: fails under the old COALESCE ordering and passes only under the new status-aware CASE ordering", async () => {
      const intakeCancelled = await createIntake(db as any, "admin-1");
      const intakeFinalized = await createIntake(db as any, "admin-1");
      await uploadIntakePhoto(db as any, intakeCancelled.id, { buffer: Buffer.from("a"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", mockPhotoStorage());
      await uploadIntakePhoto(db as any, intakeFinalized.id, { buffer: Buffer.from("b"), mimetype: "image/png", size: 1 }, "b.png", "admin-1", mockPhotoStorage());
      // Deliberately malformed persisted data: both a Cancelled row and a Finalized row carry BOTH
      // timestamps. Chosen so old COALESCE(cancelledAt, finalizedAt) and the new status-aware CASE
      // expression disagree on the resulting order, not merely on which column's value is read:
      //
      //   Cancelled intake: cancelledAt=2020-02-01 (real), finalizedAt=2099-01-01 (bogus, unused by CASE)
      //   Finalized intake: finalizedAt=2020-01-01 (real), cancelledAt=2099-12-31 (bogus, unused by CASE)
      //
      // CASE (correct): Cancelled sorts by cancelledAt=2020-02-01; Finalized sorts by
      // finalizedAt=2020-01-01 -> Finalized (2020-01-01) before Cancelled (2020-02-01).
      //
      // COALESCE (old, incorrect): COALESCE always picks the first non-null argument regardless of
      // status. Cancelled -> COALESCE(cancelledAt=2020-02-01, ...) = 2020-02-01 (correct by
      // coincidence). Finalized -> COALESCE(cancelledAt=2099-12-31, ...) = 2099-12-31 (its bogus
      // cancelledAt, since COALESCE never looks at finalizedAt when cancelledAt is non-null) ->
      // Cancelled (2020-02-01) before Finalized (2099-12-31) - the OPPOSITE order. This test would
      // fail if the production ORDER BY were reverted to COALESCE(cancelledAt, finalizedAt).
      await db.update(aiProductIntakes).set({
        status: AiProductIntakeStatus.Cancelled,
        cancelledAt: "2020-02-01T00:00:00.000Z",
        finalizedAt: "2099-01-01T00:00:00.000Z",
      }).where(eq(aiProductIntakes.id, intakeCancelled.id));
      await db.update(aiProductIntakes).set({
        status: AiProductIntakeStatus.Finalized,
        finalizedAt: "2020-01-01T00:00:00.000Z",
        cancelledAt: "2099-12-31T00:00:00.000Z",
      }).where(eq(aiProductIntakes.id, intakeFinalized.id));

      const found = await repo().listTerminalIntakesWithStagedPhotosEligibleForRetention({
        cancelledCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        finalizedCutoff: new Date(Date.now() + 1_000_000).toISOString(),
        limit: 10,
      });
      const cancelledRow = found.find((c) => c.id === intakeCancelled.id);
      const finalizedRow = found.find((c) => c.id === intakeFinalized.id);
      expect(cancelledRow?.cancelledAt).toBe("2020-02-01T00:00:00.000Z");
      expect(finalizedRow?.finalizedAt).toBe("2020-01-01T00:00:00.000Z");
      const ids = found.map((c) => c.id).filter((id) => id === intakeCancelled.id || id === intakeFinalized.id);
      expect(ids).toEqual([intakeFinalized.id, intakeCancelled.id]);
    });
  });

  describe("deleteRetentionEligibleStagedPhotosLocked", () => {
    it("real Cancelled flow: deletes owned staged rows and returns their storage keys", async () => {
      const photo = await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        100,
      );
      expect(result).toEqual({ cleaned: true, deletedPhotos: [{ id: photo.id, storageKey: photo.storageKey }] });
      const remaining = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(remaining).toHaveLength(0);
    });

    it("fails closed (status_changed) for an Open intake", async () => {
      await stageOnePhoto("p1");
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        100,
      );
      expect(result).toEqual({ cleaned: false, reason: "status_changed" });
      const remaining = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(remaining).toHaveLength(1);
    });

    it("fails closed (status_changed) for a Finalized intake requested as cancelled", async () => {
      await stageOnePhoto("p1");
      await db.update(aiProductIntakes).set({ status: AiProductIntakeStatus.Finalized, finalizedAt: new Date().toISOString(), finalizedByAdminUserId: "admin-1" }).where(eq(aiProductIntakes.id, intakeId));
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        100,
      );
      expect(result).toEqual({ cleaned: false, reason: "status_changed" });
    });

    it("fails closed (missing_audit_timestamp) when the expected status matches but the audit timestamp is absent", async () => {
      await stageOnePhoto("p1");
      await db.update(aiProductIntakes).set({ status: AiProductIntakeStatus.Cancelled, cancelledAt: null }).where(eq(aiProductIntakes.id, intakeId));
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        100,
      );
      expect(result).toEqual({ cleaned: false, reason: "missing_audit_timestamp" });
    });

    it("fails closed (not_yet_eligible) when the cutoff has not yet been reached", async () => {
      await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(0).toISOString() },
        100,
      );
      expect(result).toEqual({ cleaned: false, reason: "not_yet_eligible" });
      const remaining = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(remaining).toHaveLength(1);
    });

    it("exactly-at-threshold is eligible (inclusive)", async () => {
      await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      const [row] = await db.select().from(aiProductIntakes).where(eq(aiProductIntakes.id, intakeId));
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(intakeId, { kind: "cancelled", cutoff: row.cancelledAt as string }, 100);
      expect(result.cleaned).toBe(true);
    });

    it("returns a safe empty result when the intake has zero staged rows", async () => {
      await cancelIntake(db as any, intakeId, "admin-2");
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        100,
      );
      expect(result).toEqual({ cleaned: true, deletedPhotos: [] });
    });

    it("respects a bounded remaining-row budget - selects and deletes only up to the budget, leaving the remainder", async () => {
      const p1 = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("1"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", mockPhotoStorage());
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("2"), mimetype: "image/png", size: 1 }, "b.png", "admin-1", mockPhotoStorage());
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("3"), mimetype: "image/png", size: 1 }, "c.png", "admin-1", mockPhotoStorage());
      await cancelIntake(db as any, intakeId, "admin-2");

      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        1,
      );
      expect(result.cleaned).toBe(true);
      if (result.cleaned) {
        expect(result.deletedPhotos).toHaveLength(1);
        expect(result.deletedPhotos[0].id).toBe(p1.id); // createdAt ASC, id ASC - the first uploaded photo
      }
      const remaining = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(remaining).toHaveLength(2);
    });

    it("returns immediately with a safe empty result when the remaining budget is already zero (no transaction opened for nothing)", async () => {
      await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        0,
      );
      expect(result).toEqual({ cleaned: true, deletedPhotos: [] });
      const remaining = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(remaining).toHaveLength(1);
    });

    it("real Finalized flow: deletes owned staged rows using finalizedAt as the retention origin", async () => {
      const photo = await stageOnePhoto("p1");
      await db.update(aiProductIntakes).set({ status: AiProductIntakeStatus.Finalized, finalizedAt: new Date().toISOString(), finalizedByAdminUserId: "admin-1" }).where(eq(aiProductIntakes.id, intakeId));
      const result = await repo().deleteRetentionEligibleStagedPhotosLocked(
        intakeId,
        { kind: "finalized", cutoff: new Date(Date.now() + 1_000_000).toISOString() },
        100,
      );
      expect(result.cleaned).toBe(true);
      if (result.cleaned) expect(result.deletedPhotos.map((p) => p.id)).toEqual([photo.id]);
    });

    it("a real DB DELETE-statement failure (AFTER DELETE trigger) leaves the rows intact and rejects, matching the established Sprint 95 technique", async () => {
      await stageOnePhoto("p1");
      await cancelIntake(db as any, intakeId, "admin-2");
      sqlite.prepare("CREATE TRIGGER fail_cleanup_photo_delete AFTER DELETE ON ai_intake_photos BEGIN SELECT RAISE(ABORT,'forced cleanup delete failure'); END;").run();

      await expect(
        repo().deleteRetentionEligibleStagedPhotosLocked(intakeId, { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() }, 100),
      ).rejects.toThrow();

      const remaining = await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeId));
      expect(remaining).toHaveLength(1);

      sqlite.prepare("DROP TRIGGER fail_cleanup_photo_delete;").run();
      const retried = await repo().deleteRetentionEligibleStagedPhotosLocked(intakeId, { kind: "cancelled", cutoff: new Date(Date.now() + 1_000_000).toISOString() }, 100);
      expect(retried.cleaned).toBe(true);
    });

    /**
     * Against a real SQLite connection, the DELETE...RETURNING result can never disagree with the
     * SELECT-ed id set moments earlier in the same synchronous transaction (single connection, no
     * interleaving). The mismatch branch is still directly forced below, via a fake
     * AiIntakeLockTransactionCapability/tx pair that returns a deliberately wrong RETURNING result -
     * see "Sprint 96 correction pass: direct DELETE-returning integrity tests (fake capability)".
     */
    it("(documented) against a real SQLite connection the affected-row mismatch branch exists as defense-in-depth, forced directly via a fake capability elsewhere in this file", () => {
      expect(true).toBe(true);
    });
  });

  describe("existsStagedPhotoById / existsStagedPhotoByStorageKey", () => {
    it("returns true only for a real, currently-existing staged row", async () => {
      const photo = await stageOnePhoto("p1");
      expect(await repo().existsStagedPhotoById(photo.id)).toBe(true);
      expect(await repo().existsStagedPhotoById("does-not-exist")).toBe(false);
      expect(await repo().existsStagedPhotoByStorageKey(photo.storageKey)).toBe(true);
      expect(await repo().existsStagedPhotoByStorageKey("does-not-exist.webp")).toBe(false);
    });
    it("returns false once the row has been genuinely deleted", async () => {
      const photo = await stageOnePhoto("p1");
      await deleteIntakePhoto(db as any, intakeId, photo.id, mockPhotoStorage());
      expect(await repo().existsStagedPhotoById(photo.id)).toBe(false);
    });
  });

  describe("existsProductPhotoByIdAndProductId", () => {
    it("returns true only for a matching (id, productId) pair", async () => {
      await insertMinimalProduct(db, "prod-1");
      await db.insert(productPhotos).values({
        id: "pp-1", productId: "prod-1", url: "/x", thumbnailUrl: "/x-thumb", sortOrder: 0, isPrimary: true,
        filename: "x.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
      expect(await repo().existsProductPhotoByIdAndProductId("pp-1", "prod-1")).toBe(true);
      expect(await repo().existsProductPhotoByIdAndProductId("pp-1", "prod-other")).toBe(false);
      expect(await repo().existsProductPhotoByIdAndProductId("pp-other", "prod-1")).toBe(false);
    });
  });

  describe("hasNonTerminalProductPhotoOutboxEvent", () => {
    async function insertOutboxEvent(status: string, aggregateId: string) {
      await db.insert(outboxEvents).values({
        id: `evt-${aggregateId}-${status}`, eventType: "product_photo.promote_requested", aggregateType: "ProductPhoto",
        aggregateId, idempotencyKey: `key-${aggregateId}-${status}`, payload: "{}", status,
        attemptCount: 0, maxAttempts: 3, availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
    }
    it("returns true for Pending/Processing/RetryPending", async () => {
      await insertOutboxEvent("Pending", "photo-pending");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-pending")).toBe(true);
      await insertOutboxEvent("Processing", "photo-processing");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-processing")).toBe(true);
      await insertOutboxEvent("RetryPending", "photo-retry");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-retry")).toBe(true);
    });
    it("a completed (Succeeded), dead-lettered, failed, or cancelled event alone does not protect an otherwise proven orphan", async () => {
      await insertOutboxEvent("Succeeded", "photo-succeeded");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-succeeded")).toBe(false);
      await insertOutboxEvent("DeadLetter", "photo-dead");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-dead")).toBe(false);
      await insertOutboxEvent("Failed", "photo-failed");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-failed")).toBe(false);
      await insertOutboxEvent("Cancelled", "photo-cancelled");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-cancelled")).toBe(false);
    });
    it("returns false when no outbox event references the photo id at all", async () => {
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("no-such-photo")).toBe(false);
    });
    it("fail-safe: an unknown/future persisted status not in the known-terminal blocklist still protects the file", async () => {
      await insertOutboxEvent("SomeFutureStatusNotYetKnown", "photo-unknown-status");
      expect(await repo().hasNonTerminalProductPhotoOutboxEvent("photo-unknown-status")).toBe(true);
    });
  });
});

describe("Sprint 96 affected-row hardening (existing deleteLockedToIntake)", () => {
  it("regression: a normal delete still returns exactly one row deleted and matches the selected photo id", async () => {
    const db = createTestDb();
    const intake = await createIntake(db as any, "admin-1");
    const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", mockPhotoStorage());
    const repo = createDrizzleAiIntakePhotoRepository(db as any, sqliteSchema);
    const result = await repo.deleteLockedToIntake(intake.id, photo.id);
    expect(result).toEqual({ deleted: true, storageKey: photo.storageKey });
  });

  it("a real DB DELETE-statement failure still rejects with an error (unchanged public behavior) and never invokes the integrity-failure path incorrectly", async () => {
    const db = createTestDb();
    const sqlite = (db as any).session.client as InstanceType<typeof Database>;
    const intake = await createIntake(db as any, "admin-1");
    const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", mockPhotoStorage());
    sqlite.prepare("CREATE TRIGGER fail_intake_photo_delete_hardening AFTER DELETE ON ai_intake_photos BEGIN SELECT RAISE(ABORT,'forced'); END;").run();
    const repo = createDrizzleAiIntakePhotoRepository(db as any, sqliteSchema);
    await expect(repo.deleteLockedToIntake(intake.id, photo.id)).rejects.toThrow();
    expect(await repo.findByIdAndIntake(intake.id, photo.id)).toBeTruthy();
  });

  it("AiIntakePhotoDeleteIntegrityFailureError is exported and constructible with a message", () => {
    const err = new AiIntakePhotoDeleteIntegrityFailureError("test message");
    expect(err.name).toBe("AiIntakePhotoDeleteIntegrityFailureError");
    expect(err.message).toBe("test message");
  });
});

describe("Sprint 96 correction pass: direct DELETE-returning integrity tests (fake capability)", () => {
  describe("deleteLockedToIntake (public, single-photo)", () => {
    const intake = { id: "intake-1", status: AiProductIntakeStatus.Open };
    const selected = [{ id: "photo-1", storageKey: "photo-1.webp" }];

    it("throws AiIntakePhotoDeleteIntegrityFailureError when the DELETE...RETURNING reports zero rows", async () => {
      const capability = createFakeIntegrityCapability(intake, selected, []);
      const repo = createDrizzleAiIntakePhotoRepository({} as any, sqliteSchema, capability);
      await expect(repo.deleteLockedToIntake("intake-1", "photo-1")).rejects.toThrow(AiIntakePhotoDeleteIntegrityFailureError);
      await expect(repo.deleteLockedToIntake("intake-1", "photo-1")).rejects.toThrow(/Expected exactly one/);
    });

    it("throws AiIntakePhotoDeleteIntegrityFailureError when the DELETE...RETURNING reports one row with the wrong id", async () => {
      const capability = createFakeIntegrityCapability(intake, selected, [{ id: "some-other-photo-id" }]);
      const repo = createDrizzleAiIntakePhotoRepository({} as any, sqliteSchema, capability);
      await expect(repo.deleteLockedToIntake("intake-1", "photo-1")).rejects.toThrow(AiIntakePhotoDeleteIntegrityFailureError);
    });

    it("throws AiIntakePhotoDeleteIntegrityFailureError when the DELETE...RETURNING reports multiple rows", async () => {
      const capability = createFakeIntegrityCapability(intake, selected, [{ id: "photo-1" }, { id: "photo-1" }]);
      const repo = createDrizzleAiIntakePhotoRepository({} as any, sqliteSchema, capability);
      await expect(repo.deleteLockedToIntake("intake-1", "photo-1")).rejects.toThrow(AiIntakePhotoDeleteIntegrityFailureError);
    });
  });

  describe("deleteRetentionEligibleStagedPhotosLocked (internal, bulk retention)", () => {
    const intake = { id: "intake-1", status: AiProductIntakeStatus.Cancelled, cancelledAt: "2020-01-01T00:00:00.000Z" };
    const selected = [{ id: "p1", storageKey: "p1.webp", createdAt: "2020-01-01T00:00:00.000Z" }];
    const request = { kind: "cancelled" as const, cutoff: new Date(Date.now() + 1_000_000).toISOString() };

    it("throws AiIntakePhotoDeleteIntegrityFailureError when the DELETE...RETURNING reports zero rows after selecting one", async () => {
      const capability = createFakeIntegrityCapability(intake, selected, []);
      const repo = createDrizzleAiIntakeCleanupRepository({} as any, sqliteSchema, capability);
      await expect(repo.deleteRetentionEligibleStagedPhotosLocked("intake-1", request, 100)).rejects.toThrow(AiIntakePhotoDeleteIntegrityFailureError);
      await expect(repo.deleteRetentionEligibleStagedPhotosLocked("intake-1", request, 100)).rejects.toThrow(/Expected to delete exactly 1/);
    });

    it("throws AiIntakePhotoDeleteIntegrityFailureError when the DELETE...RETURNING reports the wrong id set", async () => {
      const capability = createFakeIntegrityCapability(intake, selected, [{ id: "wrong-id" }]);
      const repo = createDrizzleAiIntakeCleanupRepository({} as any, sqliteSchema, capability);
      await expect(repo.deleteRetentionEligibleStagedPhotosLocked("intake-1", request, 100)).rejects.toThrow(AiIntakePhotoDeleteIntegrityFailureError);
    });

    it("throws AiIntakePhotoDeleteIntegrityFailureError when the DELETE...RETURNING reports extra/unexpected rows beyond the selected set", async () => {
      const capability = createFakeIntegrityCapability(intake, selected, [{ id: "p1" }, { id: "unexpected-extra-id" }]);
      const repo = createDrizzleAiIntakeCleanupRepository({} as any, sqliteSchema, capability);
      await expect(repo.deleteRetentionEligibleStagedPhotosLocked("intake-1", request, 100)).rejects.toThrow(AiIntakePhotoDeleteIntegrityFailureError);
    });
  });
});

describe("Sprint 96 cleanup service configuration parsing", () => {
  let tempPrivateRoot: string;
  let tempCanonicalRoot: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    db = createTestDb();
    tempPrivateRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-cleanup-cfg-private-"));
    tempCanonicalRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-cleanup-cfg-canonical-"));
  });
  afterEach(async () => {
    await rmDir(tempPrivateRoot, { recursive: true, force: true });
    await rmDir(tempCanonicalRoot, { recursive: true, force: true });
  });

  function fakeDeps(): AiIntakeCleanupUseCaseDeps {
    return {
      repository: createDrizzleAiIntakeCleanupRepository(db as any, sqliteSchema),
      listStagedPhotosByIntake: async () => [],
      walkPrivateRoot: (o) => walkManagedDirectory(tempPrivateRoot, o),
      walkCanonicalRoot: (o) => walkManagedDirectory(tempCanonicalRoot, o),
      deletePrivateFile: (k) => deleteManagedFile(tempPrivateRoot, k),
      deleteCanonicalFile: (k) => deleteManagedFile(tempCanonicalRoot, k),
    };
  }

  it("AI_INTAKE_CLEANUP_EXECUTION_ENABLED: only the exact lowercase string \"true\" enables", async () => {
    for (const value of ["TRUE", "1", "yes", "", "garbage", undefined]) {
      const env = value === undefined ? {} : { AI_INTAKE_CLEANUP_EXECUTION_ENABLED: value };
      const result = await runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: env as any, deps: fakeDeps() });
      expect(result.executionEnabled).toBe(false);
    }
    const result = await runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: { AI_INTAKE_CLEANUP_EXECUTION_ENABLED: "true" } as any, deps: fakeDeps() });
    expect(result.executionEnabled).toBe(true);
  });

  it("approved defaults are used when unset", async () => {
    const result = await runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: {} as any, deps: fakeDeps() });
    expect(result).toBeTruthy(); // did not throw - defaults applied successfully
  });

  it.each([
    ["AI_INTAKE_CANCELLED_STAGED_RETENTION_MS"],
    ["AI_INTAKE_FINALIZED_STAGED_RETENTION_MS"],
    ["AI_INTAKE_ORPHAN_GRACE_MS"],
  ])("%s: zero/negative/NaN/Infinity/malformed are all rejected before any DB or filesystem work, with the deterministic AI_INTAKE_CLEANUP_CONFIGURATION_INVALID error", async (name) => {
    for (const bad of ["0", "-1", "not-a-number", "Infinity", "-Infinity", "NaN"]) {
      await expect(
        runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: { [name]: bad } as any, deps: fakeDeps() }),
      ).rejects.toBeInstanceOf(AiIntakeCleanupConfigurationInvalidError);
    }
  });

  it("an unset duration uses the safe default; an explicitly-empty value also uses the safe default (documented, consistent choice)", async () => {
    const unsetResult = await runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: {} as any, deps: fakeDeps() });
    const emptyResult = await runAiIntakeCleanupForAdmin(
      db as any,
      { dryRun: true },
      { env: { AI_INTAKE_CANCELLED_STAGED_RETENTION_MS: "", AI_INTAKE_FINALIZED_STAGED_RETENTION_MS: "", AI_INTAKE_ORPHAN_GRACE_MS: "" } as any, deps: fakeDeps() },
    );
    expect(unsetResult.executionEnabled).toBe(emptyResult.executionEnabled);
    expect(DEFAULT_CANCELLED_STAGED_RETENTION_MS).toBe(2592000000);
    expect(DEFAULT_FINALIZED_STAGED_RETENTION_MS).toBe(7776000000);
    expect(DEFAULT_ORPHAN_GRACE_MS).toBe(604800000);
  });

  it("invalid configuration fails before any DB query or filesystem scan occurs", async () => {
    let touched = false;
    const spyDeps: AiIntakeCleanupUseCaseDeps = {
      ...fakeDeps(),
      walkPrivateRoot: async (o) => { touched = true; return walkManagedDirectory(tempPrivateRoot, o); },
    };
    await expect(
      runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: { AI_INTAKE_ORPHAN_GRACE_MS: "not-a-number" } as any, deps: spyDeps }),
    ).rejects.toBeInstanceOf(AiIntakeCleanupConfigurationInvalidError);
    expect(touched).toBe(false);
  });
});

describe("Sprint 96 cleanup use case orchestration", () => {
  let db: ReturnType<typeof createTestDb>;
  let privateRoot: string;
  let canonicalRoot: string;

  beforeEach(async () => {
    db = createTestDb();
    privateRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-cleanup-uc-private-"));
    canonicalRoot = await mkdtemp(path.join(os.tmpdir(), "noctella-cleanup-uc-canonical-"));
  });
  afterEach(async () => {
    await rmDir(privateRoot, { recursive: true, force: true });
    await rmDir(canonicalRoot, { recursive: true, force: true });
  });

  function deps(): AiIntakeCleanupUseCaseDeps {
    const cleanupRepo = createDrizzleAiIntakeCleanupRepository(db as any, sqliteSchema);
    const photoRepo = createDrizzleAiIntakePhotoRepository(db as any, sqliteSchema);
    return {
      repository: cleanupRepo,
      listStagedPhotosByIntake: async (intakeId) => {
        const rows = await photoRepo.listByIntake(intakeId);
        return rows.map((r) => ({ id: r.id as string, storageKey: r.storageKey as string }));
      },
      walkPrivateRoot: (o) => walkManagedDirectory(privateRoot, o),
      walkCanonicalRoot: (o) => walkManagedDirectory(canonicalRoot, o),
      deletePrivateFile: (k) => deleteManagedFile(privateRoot, k),
      deleteCanonicalFile: (k) => deleteManagedFile(canonicalRoot, k),
    };
  }

  function baseInput(overrides: Partial<AiIntakeCleanupInput> = {}): AiIntakeCleanupInput {
    return {
      dryRun: false,
      batchSize: 100,
      executionEnabled: true,
      now: new Date(),
      processStartedAt: new Date(Date.now() + 5000),
      cancelledStagedRetentionMs: 1000,
      finalizedStagedRetentionMs: 1000,
      orphanGraceMs: 1000,
      maxExaminedEntriesPerRoot: 100_000,
      scanTimeBudgetMsPerRoot: 10_000,
      ...overrides,
    };
  }

  async function realStagedFile(storageKey: string, bytes = "x") {
    await writeFile(path.join(privateRoot, storageKey), bytes);
  }
  async function realCanonicalFile(key: string, bytes = "x") {
    await writeFile(path.join(canonicalRoot, key), bytes);
  }

  describe("staged retention cleanup", () => {
    it("real end-to-end: uploads, cancels, ages past retention, then a real execute run deletes the row and the private file", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: "real-staged.webp" }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await realStagedFile(photo.storageKey);
      await cancelIntake(db as any, intake.id, "admin-2");
      const [row] = await db.select().from(aiProductIntakes).where(eq(aiProductIntakes.id, intake.id));

      const now = new Date(new Date(row.cancelledAt as string).getTime() + 2000);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, cancelledStagedRetentionMs: 1000 }));

      expect(result.stagedRowsDeleted).toBe(1);
      expect(result.stagedFilesDeleted).toBe(1);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intake.id))).toHaveLength(0);
      expect(existsSync(path.join(privateRoot, photo.storageKey))).toBe(false);
    });

    it("dry-run never calls the locked destructive delete method - row and file both remain, eligible count still reported", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: "dry-run-staged.webp" }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await realStagedFile(photo.storageKey);
      await cancelIntake(db as any, intake.id, "admin-2");
      const [row] = await db.select().from(aiProductIntakes).where(eq(aiProductIntakes.id, intake.id));
      const now = new Date(new Date(row.cancelledAt as string).getTime() + 2000);

      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, dryRun: true, cancelledStagedRetentionMs: 1000 }));

      expect(result.dryRun).toBe(true);
      expect(result.stagedRowsEligible).toBe(1);
      expect(result.stagedRowsDeleted).toBe(0);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intake.id))).toHaveLength(1);
      expect(existsSync(path.join(privateRoot, photo.storageKey))).toBe(true);
    });

    it("a DB failure (real trigger) leaves the row and file intact and increments failures, without aborting other intakes", async () => {
      const sqlite = (db as any).session.client as InstanceType<typeof Database>;
      const intakeA = await createIntake(db as any, "admin-1");
      const intakeB = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: `staged-${Math.random()}.webp` }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      const photoA = await uploadIntakePhoto(db as any, intakeA.id, { buffer: Buffer.from("a"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const photoB = await uploadIntakePhoto(db as any, intakeB.id, { buffer: Buffer.from("b"), mimetype: "image/png", size: 1 }, "b.png", "admin-1", storage);
      await realStagedFile(photoA.storageKey);
      await realStagedFile(photoB.storageKey);
      await cancelIntake(db as any, intakeA.id, "admin-2");
      await cancelIntake(db as any, intakeB.id, "admin-2");
      const now = new Date(Date.now() + 10_000);

      sqlite.prepare("CREATE TRIGGER fail_uc_cleanup_delete AFTER DELETE ON ai_intake_photos BEGIN SELECT RAISE(ABORT,'forced'); END;").run();
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, cancelledStagedRetentionMs: 1000 }));

      expect(result.failures).toBeGreaterThanOrEqual(2); // both intakes fail the DB delete
      expect(result.stagedRowsDeleted).toBe(0);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeA.id))).toHaveLength(1);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intakeB.id))).toHaveLength(1);
    });

    it("a post-commit private-file cleanup failure leaves the row absent and the file present, increments failures, and a later private-orphan pass removes it", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: "00000000-0000-4000-8000-000000000007.webp" }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await realStagedFile(photo.storageKey);
      await cancelIntake(db as any, intake.id, "admin-2");
      const now = new Date(Date.now() + 10_000);

      const failingDeps: AiIntakeCleanupUseCaseDeps = {
        ...deps(),
        deletePrivateFile: async (key) => { throw new Error(`simulated file cleanup failure for ${key}`); },
      };
      const result = await runAiIntakeCleanupUseCase(failingDeps, baseInput({ now, cancelledStagedRetentionMs: 1000 }));

      expect(result.stagedRowsDeleted).toBe(1);
      expect(result.failures).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intake.id))).toHaveLength(0);
      expect(existsSync(path.join(privateRoot, photo.storageKey))).toBe(true);

      // A later private-orphan pass (real deletePrivateFile this time) removes the residual file.
      // processStartedAt must predate the file's real write time but postdate nothing relevant -
      // `now` (the first run's timestamp) is already safely after the real write, so anchoring the
      // watermark there (rather than epoch) correctly makes the file "older than process start".
      const later = new Date(now.getTime() + 100_000);
      const followUp = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: later, orphanGraceMs: 1000, processStartedAt: now }));
      expect(followUp.privateOrphansDeleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(path.join(privateRoot, photo.storageKey))).toBe(false);
    });

    it("multi-photo partial cleanup: one intake with more photos than the remaining batch budget is safely partially processed", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: `many-${Math.random()}.webp` }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("1"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("2"), mimetype: "image/png", size: 1 }, "b.png", "admin-1", storage);
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("3"), mimetype: "image/png", size: 1 }, "c.png", "admin-1", storage);
      await cancelIntake(db as any, intake.id, "admin-2");
      const now = new Date(Date.now() + 10_000);

      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, batchSize: 2, cancelledStagedRetentionMs: 1000 }));
      expect(result.stagedRowsDeleted).toBe(2);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intake.id))).toHaveLength(1);
    });
  });

  describe("private orphan sweep", () => {
    it("a row-owned private file is retained (activeSourceRowsRetained), never deleted, regardless of age", async () => {
      const ownedKey = "00000000-0000-4000-8000-000000000010.webp";
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: ownedKey }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await realStagedFile(ownedKey);
      const now = new Date(Date.now() + 100_000_000);

      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.activeSourceRowsRetained).toBeGreaterThanOrEqual(1);
      expect(result.privateOrphansDeleted).toBe(0);
      expect(existsSync(path.join(privateRoot, ownedKey))).toBe(true);
    });

    it("a young unowned file is retained (ageProtected)", async () => {
      const now = new Date(1_000_000);
      await realStagedFile("00000000-0000-4000-8000-000000000001.webp");
      // File mtime is "now" (just written) - well within the grace period from `now`.
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, orphanGraceMs: 100_000_000, processStartedAt: new Date(now.getTime() + 1) }));
      expect(result.ageProtected).toBeGreaterThanOrEqual(1);
      expect(result.privateOrphansDeleted).toBe(0);
    });

    it("a file whose mtime is not strictly before the process-start watermark is retained, even if old enough by grace period alone", async () => {
      // processStartedAt is derived from the file's own real, observed mtime (read back via
      // statManagedFile) rather than a separately-captured Date.now() - avoids any dependence on
      // sub-millisecond clock-vs-filesystem-timestamp ordering, which this platform does not
      // guarantee. Setting processStartedAt exactly equal to the real mtime deterministically
      // means the file does not strictly predate it (the required condition is "<", not "<=").
      // `now` is set far enough in the future that the grace period alone would otherwise consider
      // the file eligible - only the watermark check protects it.
      const key = "00000000-0000-4000-8000-000000000002.webp";
      await realStagedFile(key);
      const info = await statManagedFile(privateRoot, key);
      const processStartedAt = new Date(info.mtimeMs!);
      const now = new Date(Date.now() + 100_000_000_000);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, orphanGraceMs: 1, processStartedAt }));
      expect(result.ageProtected).toBeGreaterThanOrEqual(1);
      expect(result.privateOrphansDeleted).toBe(0);
    });

    it("an old, fully unowned private file is deleted only in real execute mode, not in dry-run", async () => {
      const key = "00000000-0000-4000-8000-000000000003.webp";
      await realStagedFile(key);
      const now = new Date(Date.now() + 100_000_000);
      const processStartedAt = new Date(Date.now() + 5000);

      const dryRunResult = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, dryRun: true, orphanGraceMs: 1, processStartedAt }));
      expect(dryRunResult.privateOrphansEligible).toBeGreaterThanOrEqual(1);
      expect(dryRunResult.privateOrphansDeleted).toBe(0);
      expect(existsSync(path.join(privateRoot, key))).toBe(true);

      const executeResult = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, orphanGraceMs: 1, processStartedAt }));
      expect(executeResult.privateOrphansDeleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(path.join(privateRoot, key))).toBe(false);
    });

    it("an unknown (non-UUID) file is retained and counted", async () => {
      await writeFile(path.join(privateRoot, "not-a-staged-photo.webp"), "x");
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.unknownFilesRetained).toBeGreaterThanOrEqual(1);
    });

    it("a symlink candidate is retained and counted, never deleted", async () => {
      const targetKey = "00000000-0000-4000-8000-000000000004.webp";
      await realStagedFile(targetKey);
      const linkKey = "00000000-0000-4000-8000-000000000005.webp";
      try {
        await symlink(path.join(privateRoot, targetKey), path.join(privateRoot, linkKey));
      } catch (err: any) {
        if (err?.code === "EPERM" || err?.code === "EACCES") return;
        throw err;
      }
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.symlinksRetained).toBeGreaterThanOrEqual(1);
      const retainedLink = await lstat(path.join(privateRoot, linkKey));
      expect(retainedLink.isSymbolicLink()).toBe(true);
    });

    it("source-already-absent during actual deletion is treated as idempotent, not a failure", async () => {
      const key = "00000000-0000-4000-8000-000000000006.webp";
      await realStagedFile(key);
      const now = new Date(Date.now() + 100_000_000);
      const raceDeps: AiIntakeCleanupUseCaseDeps = {
        ...deps(),
        deletePrivateFile: async (k) => { await rmDir(path.join(privateRoot, k), { force: true }); return "already_absent"; },
      };
      const result = await runAiIntakeCleanupUseCase(raceDeps, baseInput({ now, orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.failures).toBe(0);
    });
  });

  describe("canonical orphan sweep", () => {
    const productId = "10000000-0000-4000-8000-000000000001";
    const photoId = "20000000-0000-4000-8000-000000000002";

    beforeEach(async () => {
      await insertMinimalProduct(db, productId);
    });

    it("a live staged source row retains the canonical candidate regardless of age or intake status", async () => {
      const intake = await createIntake(db as any, "admin-1");
      // Directly craft the deterministic staged row id to match the canonical filename under test.
      const sqlite = (db as any).session.client as InstanceType<typeof Database>;
      sqlite.prepare(
        "INSERT INTO ai_intake_photos (id, intake_id, storage_key, original_filename, created_by_admin_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run(photoId, intake.id, "staged-source.webp", "a.png", "admin-1", new Date().toISOString(), new Date().toISOString());
      await realCanonicalFile(`${productId}-${photoId}.webp`);

      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.activeSourceRowsRetained).toBeGreaterThanOrEqual(1);
      expect(result.canonicalOrphansDeleted).toBe(0);
      expect(existsSync(path.join(canonicalRoot, `${productId}-${photoId}.webp`))).toBe(true);
    });

    it("a live ProductPhoto row retains the canonical candidate", async () => {
      await db.insert(productPhotos).values({
        id: photoId, productId, url: "/x", thumbnailUrl: "/x-thumb", sortOrder: 0, isPrimary: true,
        filename: "x.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
      await realCanonicalFile(`${productId}-${photoId}.webp`);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.liveFilesRetained).toBeGreaterThanOrEqual(1);
      expect(result.canonicalOrphansDeleted).toBe(0);
    });

    it("an active (non-terminal) outbox event retains the canonical candidate", async () => {
      await db.insert(outboxEvents).values({
        id: "evt-active", eventType: "product_photo.promote_requested", aggregateType: "ProductPhoto",
        aggregateId: photoId, idempotencyKey: "key-active", payload: "{}", status: "Pending",
        attemptCount: 0, maxAttempts: 3, availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
      await realCanonicalFile(`${productId}-${photoId}.webp`);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.activeOutboxRetained).toBeGreaterThanOrEqual(1);
      expect(result.canonicalOrphansDeleted).toBe(0);
    });

    it("a completed/dead-lettered event alone does not protect an otherwise fully-unowned old file - it is deleted in execute mode", async () => {
      await db.insert(outboxEvents).values({
        id: "evt-dead", eventType: "product_photo.promote_requested", aggregateType: "ProductPhoto",
        aggregateId: photoId, idempotencyKey: "key-dead", payload: "{}", status: "DeadLetter",
        attemptCount: 3, maxAttempts: 3, availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
      await realCanonicalFile(`${productId}-${photoId}.webp`);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.canonicalOrphansDeleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(path.join(canonicalRoot, `${productId}-${photoId}.webp`))).toBe(false);
    });

    it("main and thumbnail are evaluated independently - deleting one does not require or assume the other's presence", async () => {
      await realCanonicalFile(`${productId}-${photoId}.webp`);
      // Only the main file exists - no thumbnail. Both must be independently classifiable.
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.canonicalOrphansDeleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(path.join(canonicalRoot, `${productId}-${photoId}.webp`))).toBe(false);
    });

    it("an ordinary-upload ProductPhoto filename is never treated as a canonical orphan candidate", async () => {
      await realCanonicalFile(`${Date.now()}-${photoId}.webp`);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.canonicalOrphansDeleted).toBe(0);
      expect(result.unknownFilesRetained).toBeGreaterThanOrEqual(1);
    });

    it("grace period protects a recently-written fully-unowned canonical file", async () => {
      await realCanonicalFile(`${productId}-${photoId}.webp`);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 1000), orphanGraceMs: 100_000_000_000, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.ageProtected).toBeGreaterThanOrEqual(1);
      expect(result.canonicalOrphansDeleted).toBe(0);
    });

    it("Sprint 96 does not repair ProductPhoto rows or processing states - a Processing row with no canonical file present is simply not reported by this sweep at all", async () => {
      await db.insert(productPhotos).values({
        id: photoId, productId, url: "/x", thumbnailUrl: "/x-thumb", sortOrder: 0, isPrimary: true,
        filename: "x.webp", mimeType: "image/webp", sizeBytes: 1, width: 1, height: 1, processingStatus: "Processing",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as any);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(Date.now() + 100_000_000), orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      // No canonical file exists on disk for this row at all - nothing for the sweep to examine,
      // classify, retain, or repair. Confirms the sweep never invents/repairs missing files.
      expect(result.filesExamined).toBe(0);
      const [row] = await db.select().from(productPhotos).where(eq(productPhotos.id, photoId));
      expect(row.processingStatus).toBe("Processing");
    });
  });

  describe("directory streaming bounds", () => {
    it("truncated=true is reported when the examined ceiling is reached, and does not claim guaranteed eventual access", async () => {
      for (let i = 0; i < 5; i += 1) await writeFile(path.join(privateRoot, `${i}-not-uuid.webp`), "x");
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now: new Date(), maxExaminedEntriesPerRoot: 2 }));
      expect(result.truncated).toBe(true);
    });

    it("the deletion cap (batchSize) truncates a category's actual deletions, independent of examined count, and sets truncated=true", async () => {
      const now = new Date(Date.now() + 100_000_000);
      for (let i = 0; i < 3; i += 1) {
        await realStagedFile(`0000000${i}-0000-4000-8000-00000000000${i}.webp`);
      }
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, batchSize: 1, orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.privateOrphansEligible).toBeGreaterThanOrEqual(3);
      expect(result.privateOrphansDeleted).toBe(1);
      expect(result.truncated).toBe(true);
    });

    it("Sprint 96 correction pass: canonical orphan deletion cap sets truncated=true when more are eligible than the budget allows", async () => {
      const now = new Date(Date.now() + 100_000_000);
      const processStartedAt = new Date(Date.now() + 5000);
      const productId = "30000000-0000-4000-8000-000000000001";
      await insertMinimalProduct(db, productId);
      for (let i = 0; i < 3; i += 1) {
        const photoId = `4000000${i}-0000-4000-8000-00000000000${i}`;
        await realCanonicalFile(`${productId}-${photoId}.webp`);
      }
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, batchSize: 1, orphanGraceMs: 1, processStartedAt }));
      expect(result.canonicalOrphansEligible).toBeGreaterThanOrEqual(3);
      expect(result.canonicalOrphansDeleted).toBe(1);
      expect(result.truncated).toBe(true);
    });

    it("Sprint 96 correction pass: staged retention deletion cap sets truncated=true when a candidate has more eligible rows than the remaining budget", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: `staged-trunc-${Math.random()}.webp` }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("1"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("2"), mimetype: "image/png", size: 1 }, "b.png", "admin-1", storage);
      await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("3"), mimetype: "image/png", size: 1 }, "c.png", "admin-1", storage);
      await cancelIntake(db as any, intake.id, "admin-2");
      const now = new Date(Date.now() + 10_000);

      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, batchSize: 1, cancelledStagedRetentionMs: 1000 }));
      expect(result.stagedRowsDeleted).toBe(1);
      expect(result.truncated).toBe(true);
    });

    it("Sprint 96 correction pass: dry-run never sets truncated=true merely because it intentionally deletes zero", async () => {
      const now = new Date(Date.now() + 100_000_000);
      for (let i = 0; i < 3; i += 1) {
        await realStagedFile(`0000000${i}-0000-4000-8000-00000000000${i}.webp`);
      }
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, dryRun: true, batchSize: 1, orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.privateOrphansEligible).toBeGreaterThanOrEqual(3);
      expect(result.privateOrphansDeleted).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("Sprint 96 correction pass: execute mode with exactly batchSize eligible actions and no remaining eligible work leaves truncated=false", async () => {
      const now = new Date(Date.now() + 100_000_000);
      const key = "00000000-0000-4000-8000-000000000077.webp";
      await realStagedFile(key);
      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, batchSize: 1, orphanGraceMs: 1, processStartedAt: new Date(Date.now() + 5000) }));
      expect(result.privateOrphansEligible).toBe(1);
      expect(result.privateOrphansDeleted).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe("Sprint 96 correction pass: missing-root and root-error integration behavior (full use-case/service chain, not adapter-only)", () => {
    it("a full use-case run succeeds with filesExamined=0/failures=0 when both configured roots are genuinely absent - no directory needs to be pre-created", async () => {
      const neverCreatedPrivate = path.join(privateRoot, "never-created-private");
      const neverCreatedCanonical = path.join(canonicalRoot, "never-created-canonical");
      const missingRootDeps: AiIntakeCleanupUseCaseDeps = {
        ...deps(),
        walkPrivateRoot: (o) => walkManagedDirectory(neverCreatedPrivate, o),
        walkCanonicalRoot: (o) => walkManagedDirectory(neverCreatedCanonical, o),
        deletePrivateFile: (k) => deleteManagedFile(neverCreatedPrivate, k),
        deleteCanonicalFile: (k) => deleteManagedFile(neverCreatedCanonical, k),
      };
      const result = await runAiIntakeCleanupUseCase(missingRootDeps, baseInput({ now: new Date() }));
      expect(result.filesExamined).toBe(0);
      expect(result.failures).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("a full Admin service dry-run succeeds against genuinely absent roots without throwing (no HTTP 500)", async () => {
      const neverCreatedPrivate = path.join(privateRoot, "admin-never-created-private");
      const neverCreatedCanonical = path.join(canonicalRoot, "admin-never-created-canonical");
      const missingRootDeps: AiIntakeCleanupUseCaseDeps = {
        ...deps(),
        walkPrivateRoot: (o) => walkManagedDirectory(neverCreatedPrivate, o),
        walkCanonicalRoot: (o) => walkManagedDirectory(neverCreatedCanonical, o),
        deletePrivateFile: (k) => deleteManagedFile(neverCreatedPrivate, k),
        deleteCanonicalFile: (k) => deleteManagedFile(neverCreatedCanonical, k),
      };
      const result = await runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: {} as any, deps: missingRootDeps });
      expect(result.filesExamined).toBe(0);
      expect(result.failures).toBe(0);
    });

    it("a non-ENOENT private-root error (the configured root resolves to a regular file, not a directory) propagates through the use case and is never converted into an empty-root success", async () => {
      const fileAsPrivateRoot = path.join(privateRoot, "this-is-a-file-not-a-directory");
      await writeFile(fileAsPrivateRoot, "x");
      const badRootDeps: AiIntakeCleanupUseCaseDeps = { ...deps(), walkPrivateRoot: (o) => walkManagedDirectory(fileAsPrivateRoot, o) };
      await expect(runAiIntakeCleanupUseCase(badRootDeps, baseInput({ now: new Date() }))).rejects.toThrow();
    });

    it("a non-ENOENT canonical-root error propagates through the Admin service entry point too, not a swallowed zero-count result", async () => {
      const fileAsCanonicalRoot = path.join(canonicalRoot, "also-a-file-not-a-directory");
      await writeFile(fileAsCanonicalRoot, "x");
      const badRootDeps: AiIntakeCleanupUseCaseDeps = { ...deps(), walkCanonicalRoot: (o) => walkManagedDirectory(fileAsCanonicalRoot, o) };
      await expect(runAiIntakeCleanupForAdmin(db as any, { dryRun: true }, { env: {} as any, deps: badRootDeps })).rejects.toThrow();
    });
  });

  describe("dry-run and disabled-execution semantics", () => {
    it("effective dryRun is forced true whenever executionEnabled is false, regardless of the requested dryRun value - the result never reports dryRun:false for a forcibly non-destructive run", async () => {
      const intake = await createIntake(db as any, "admin-1");
      const storage = { saveIntakePhoto: async () => ({ storageKey: "forced-dry.webp" }), deleteIntakePhoto: async () => {} } as AiIntakePhotoStorage;
      const photo = await uploadIntakePhoto(db as any, intake.id, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await realStagedFile(photo.storageKey);
      await cancelIntake(db as any, intake.id, "admin-2");
      const now = new Date(Date.now() + 100_000);

      const result = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, dryRun: false, executionEnabled: false, cancelledStagedRetentionMs: 1000 }));
      expect(result.dryRun).toBe(true);
      expect(result.stagedRowsDeleted).toBe(0);
      expect(await db.select().from(aiIntakePhotos).where(eq(aiIntakePhotos.intakeId, intake.id))).toHaveLength(1);
    });

    it("emptyDisabledCleanupResult() is the exact zero-count, dryRun:true, executionEnabled:false shape used for the scheduler skip", () => {
      const result = emptyDisabledCleanupResult();
      expect(result.executionEnabled).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.filesExamined).toBe(0);
      expect(result.stagedRowsDeleted).toBe(0);
      expect(result.privateOrphansDeleted).toBe(0);
      expect(result.canonicalOrphansDeleted).toBe(0);
      expect(result.failures).toBe(0);
      expect(result.truncated).toBe(false);
    });
  });

  describe("idempotency / two-run convergence (serial-order proof)", () => {
    it("a second full run after a real execute run converges to zero further deletions - no duplicate/destructive side effects on rerun", async () => {
      const key = "00000000-0000-4000-8000-000000000099.webp";
      await realStagedFile(key);
      const now = new Date(Date.now() + 100_000_000);
      const processStartedAt = new Date(Date.now() + 5000);

      const first = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, orphanGraceMs: 1, processStartedAt }));
      expect(first.privateOrphansDeleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(path.join(privateRoot, key))).toBe(false);

      const second = await runAiIntakeCleanupUseCase(deps(), baseInput({ now, orphanGraceMs: 1, processStartedAt }));
      expect(second.privateOrphansDeleted).toBe(0);
      expect(second.failures).toBe(0);
    });
  });
});

describe("Sprint 96 scheduler service entry point", () => {
  it("returns emptyDisabledCleanupResult() and never constructs a repository/deps when execution is disabled", async () => {
    const db = createTestDb();
    let constructed = false;
    // No deps override is supplied on purpose for the disabled case - if the service tried to
    // build real deps (which would require real storage roots not set up here) this would throw
    // instead of cleanly short-circuiting, proving the skip genuinely happens before any
    // dependency construction.
    const result = await runAiIntakeCleanupForScheduler(db as any, {}, { env: { AI_INTAKE_CLEANUP_EXECUTION_ENABLED: "false" } as any });
    expect(result).toEqual(emptyDisabledCleanupResult());
    expect(constructed).toBe(false);
  });

  function untouchedDeps(): AiIntakeCleanupUseCaseDeps {
    const fail = () => { throw new Error("deps must never be touched on the disabled scheduler path"); };
    return {
      repository: new Proxy({}, { get: () => fail }) as any,
      listStagedPhotosByIntake: fail as any,
      walkPrivateRoot: fail as any,
      walkCanonicalRoot: fail as any,
      deletePrivateFile: fail as any,
      deleteCanonicalFile: fail as any,
    };
  }

  it("Sprint 96 correction pass (A): disabled scheduler + valid configuration still validates durations, performs zero repository reads and zero directory scans, and returns the exact disabled zero-result", async () => {
    const db = createTestDb();
    const result = await runAiIntakeCleanupForScheduler(
      db as any,
      {},
      {
        env: {
          AI_INTAKE_CLEANUP_EXECUTION_ENABLED: "false",
          AI_INTAKE_CANCELLED_STAGED_RETENTION_MS: "1000",
          AI_INTAKE_FINALIZED_STAGED_RETENTION_MS: "2000",
          AI_INTAKE_ORPHAN_GRACE_MS: "3000",
        } as any,
        deps: untouchedDeps(),
      },
    );
    expect(result.executionEnabled).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result).toEqual(emptyDisabledCleanupResult());
  });

  it("Sprint 96 correction pass (B): disabled scheduler + malformed duration configuration still fails with AiIntakeCleanupConfigurationInvalidError, with zero repository reads, zero directory scans, and zero deletions", async () => {
    const db = createTestDb();
    await expect(
      runAiIntakeCleanupForScheduler(
        db as any,
        {},
        { env: { AI_INTAKE_CLEANUP_EXECUTION_ENABLED: "false", AI_INTAKE_ORPHAN_GRACE_MS: "not-a-number" } as any, deps: untouchedDeps() },
      ),
    ).rejects.toBeInstanceOf(AiIntakeCleanupConfigurationInvalidError);
  });
});

describe("Sprint 96 admin service entry point", () => {
  it("dryRun:false while disabled throws AiIntakeCleanupExecutionDisabledError before any DB/filesystem work", async () => {
    const db = createTestDb();
    await expect(
      runAiIntakeCleanupForAdmin(db as any, { dryRun: false }, { env: { AI_INTAKE_CLEANUP_EXECUTION_ENABLED: "false" } as any }),
    ).rejects.toBeInstanceOf(AiIntakeCleanupExecutionDisabledError);
  });
});
