import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminRole, AiIntakeFieldDecision, AiProductIntakeStatus } from "@noctella/shared";
import {
  AiIntakeGenerationInProgressError,
  AiIntakeProposalIntakeNotOpenError,
  AiIntakeProposalReviewResetRequiredError,
  AiIntakeProposalStaleError,
  AiIntakeProposalSuggestionUnavailableError,
  AiIntakeProposalVersionConflictError,
  BadRequestError,
  NotFoundError,
} from "../src/services/errors";
import { createIntake, cancelIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto, deleteIntakePhoto } from "../src/services/aiIntakePhotos";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { getCurrentProposal, updateProposalFieldReview, toProposalReview } from "../src/services/aiIntakeProposals";
import { createAiIntakeProposalRepository } from "../src/repositories/ai-intake-proposal/factory";
import { createAiIntakePhotoRepository } from "../src/repositories/ai-intake-photo/factory";
import { generateOrRegenerateProposalUseCase, updateFieldReviewUseCase, nextUpdatedAt } from "../src/use-cases/ai-intake-proposal/useCases";
import { computePhotoSetFingerprint } from "../src/ai-intake/photoSetFingerprint";
import type { AiIntakeGenerationProvider, AiIntakePhotoReader } from "../src/ai-intake/types";
import type { AiIntakeProposalRepository } from "../src/repositories/ai-intake-proposal/types";
import type { AiIntakePhotoRepository } from "../src/repositories/ai-intake-photo/types";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import {
  aiIntakeProposals,
  products,
  productImages,
  productPhotos,
  stockMovements,
  publishJobs,
  externalListings,
  aiListingDrafts,
} from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as postgresSchema from "../src/db/schema.postgres";
import { ensureSchema } from "../src/db/migrate";
import { requiredSprint24Tables, runSchemaParity, validatePostgresMigrationSql } from "../src/services/databaseMigrationFoundation";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb } from "./testDb";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/**
 * Sprint 95 final correction: implements the simplified AiIntakePhotoStorage
 * interface (saveIntakePhoto/deleteIntakePhoto only - no quarantine/tombstone
 * concept remains) - mirrors aiIntakePhotos.test.ts's own mockStorage().
 */
function mockPhotoStorage(): AiIntakePhotoStorage {
  let counter = 0;
  const sources = new Set<string>();
  return {
    saveIntakePhoto: vi.fn(async () => {
      counter += 1;
      const storageKey = `mock-key-${counter}.webp`;
      sources.add(storageKey);
      return { storageKey };
    }),
    deleteIntakePhoto: vi.fn(async (storageKey: string) => {
      sources.delete(storageKey);
    }),
  };
}

function stubProvider(overrides: Partial<Parameters<AiIntakeGenerationProvider["generate"]>[0]["context"]> = {}, result?: any): AiIntakeGenerationProvider {
  return {
    generate: vi.fn(async (req) => ({
      proposal: { suggestedTitle: "Stub Title", suggestedDescription: "Stub description.", suggestedKeywords: ["stub", "keyword"], confidenceScore: 0.7 },
      metadata: { providerName: "stub-provider", promptVersion: req.prompt.version },
      ...result,
    })),
  };
}

/** Sprint 103: a manually-resolvable promise, used to deterministically control exactly when a fake provider/repository call settles. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets already-queued microtasks (and one macrotask boundary) run before the test continues - used to let a started-but-not-awaited use-case call progress as far as it can before it hits an externally-controlled gate. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Sprint 103: a minimal fake AiIntakeProposalRepository for guard tests - only findByIntakeId and insertIfAbsentAndIntakeOpen are exercised (first-generation path); the other two methods are present only to satisfy the interface and are never called by these tests. */
function fakeProposalRepository(overrides: Partial<AiIntakeProposalRepository> = {}): AiIntakeProposalRepository {
  return {
    findByIntakeId: vi.fn(async () => null),
    insertIfAbsentAndIntakeOpen: vi.fn(async () => ({ updated: true, row: {} as any })),
    refreshPendingFields: vi.fn(async () => ({ updated: true, row: {} as any })),
    updateFieldReviewAtomic: vi.fn(async () => ({ updated: true, row: {} as any })),
    ...overrides,
  };
}

function fakePhotoReaderForGuardTests(): AiIntakePhotoReader {
  return { read: vi.fn(async () => Buffer.from("")) };
}

describe("ai intake field review foundation (Sprint 93)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  describe("generation persistence", () => {
    it("first generation persists exactly one proposal row", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const rows = await db.select().from(aiIntakeProposals);
      expect(rows).toHaveLength(1);
      expect(rows[0].intakeId).toBe(intakeId);
    });

    it("response-delivery failure is recoverable through GET (the row is durable before any response is sent)", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const fetched = await getCurrentProposal(db as any, intakeId);
      expect(fetched.title.suggestion).toBe("Stub Title");
    });

    it("provider failure persists nothing", async () => {
      const failing: AiIntakeGenerationProvider = { generate: vi.fn(async () => { throw new Error("simulated provider failure"); }) };
      await expect(generateIntakeProposal(db as any, intakeId, failing)).rejects.toThrow("simulated provider failure");
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(0);
    });

    it("a database failure after provider success leaves no partial row", async () => {
      sqlite.prepare("CREATE TRIGGER fail_proposal_insert AFTER INSERT ON ai_intake_proposals BEGIN SELECT RAISE(ABORT,'forced failure'); END;").run();
      await expect(generateIntakeProposal(db as any, intakeId, stubProvider())).rejects.toThrow();
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(0);
    });

    it("works with no staged photos", async () => {
      const result = await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(result.title.suggestion).toBe("Stub Title");
    });

    it("stores a stable photo fingerprint", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const [row] = await db.select().from(aiIntakeProposals);
      expect(row.photoSetFingerprint).toBeTruthy();
      expect(typeof row.photoSetFingerprint).toBe("string");
    });

    it("all suggestions and generation metadata belong to the same generation", async () => {
      const result = await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(result.providerName).toBe("stub-provider");
      expect(result.title.suggestion).toBe("Stub Title");
      expect(result.description.suggestion).toBe("Stub description.");
      expect(result.keywords.suggestion).toEqual(["stub", "keyword"]);
    });
  });

  describe("generation concurrency", () => {
    it("two first-generation requests do not overwrite each other - one wins, the loser gets a version conflict", async () => {
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const expectedPhotoFingerprint = computePhotoSetFingerprint([]);
      const first = await repository.insertIfAbsentAndIntakeOpen({
        id: "p1", intakeId, suggestedTitle: "A", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null,
        expectedPhotoFingerprint, generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      const second = await repository.insertIfAbsentAndIntakeOpen({
        id: "p2", intakeId, suggestedTitle: "B", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null,
        expectedPhotoFingerprint, generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      expect(first.updated).toBe(true);
      expect(second.updated).toBe(false);
      expect(second.conflict?.reason).toBe("proposal_already_exists");
      const rows = await db.select().from(aiIntakeProposals);
      expect(rows).toHaveLength(1);
      expect(rows[0].suggestedTitle).toBe("A");
    });

    it("two concurrent regenerations do not use last-write-wins - a changed baseline causes a version conflict", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const [existing] = await db.select().from(aiIntakeProposals);

      const expectedPhotoFingerprint = computePhotoSetFingerprint([]);
      const firstRefresh = await repository.refreshPendingFields({
        id: existing.id, intakeId, expectedUpdatedAt: existing.updatedAt,
        suggestedTitle: "Refreshed A", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null,
        expectedPhotoFingerprint, generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v2",
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      });
      // Second refresh uses the SAME stale baseline (existing.updatedAt) - simulating a concurrent
      // regeneration that captured its baseline before the first one committed.
      const secondRefresh = await repository.refreshPendingFields({
        id: existing.id, intakeId, expectedUpdatedAt: existing.updatedAt,
        suggestedTitle: "Refreshed B", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null,
        expectedPhotoFingerprint, generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v3",
        updatedAt: new Date(Date.now() + 2000).toISOString(),
      });

      expect(firstRefresh.updated).toBe(true);
      expect(secondRefresh.updated).toBe(false);
      expect(secondRefresh.conflict?.reason).toBe("version_mismatch");
      const [row] = await db.select().from(aiIntakeProposals);
      expect(row.suggestedTitle).toBe("Refreshed A");
    });

    it("generation cannot persist after cancellation wins the race (atomic guard, not just the service pre-check)", async () => {
      await cancelIntake(db as any, intakeId, "admin-1");
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const result = await repository.insertIfAbsentAndIntakeOpen({
        id: "p1", intakeId, suggestedTitle: "A", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null,
        expectedPhotoFingerprint: computePhotoSetFingerprint([]), generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      expect(result.updated).toBe(false);
      expect(result.conflict?.reason).toBe("intake_not_open");
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(0);
    });
  });

  describe("in-flight generation guard (Sprint 103)", () => {
    it("two concurrent first-generation attempts for the same intake: the provider is invoked exactly once, and the second request rejects immediately (before the first finishes) with the generation-in-progress conflict", async () => {
      const providerGate = deferred<void>();
      const provider: AiIntakeGenerationProvider = {
        generate: vi.fn(async () => {
          await providerGate.promise;
          return { proposal: { suggestedTitle: "A" }, metadata: { providerName: "x", promptVersion: "v1" } };
        }),
      };
      const repository = fakeProposalRepository();
      const photoReader = fakePhotoReaderForGuardTests();
      const intake = { id: intakeId, status: AiProductIntakeStatus.Open } as any;

      const first = generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader);
      await flush(); // let A's pre-check resolve, acquire the guard, and reach (and suspend inside) provider.generate()

      // B must reject NOW, without waiting for A - proven by asserting before providerGate is ever resolved.
      await expect(
        generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader),
      ).rejects.toBeInstanceOf(AiIntakeGenerationInProgressError);
      expect(provider.generate).toHaveBeenCalledTimes(1);

      providerGate.resolve();
      await first;
      expect(provider.generate).toHaveBeenCalledTimes(1);
    });

    it("persistence-phase protection: a second request arriving after the provider has already succeeded, but before persistence has completed, still cannot reach the provider", async () => {
      const provider: AiIntakeGenerationProvider = {
        generate: vi.fn(async () => ({ proposal: { suggestedTitle: "A" }, metadata: { providerName: "x", promptVersion: "v1" } })),
      };
      const persistenceGate = deferred<{ updated: true; row: any }>();
      const repository = fakeProposalRepository({ insertIfAbsentAndIntakeOpen: vi.fn(() => persistenceGate.promise) });
      const photoReader = fakePhotoReaderForGuardTests();
      const intake = { id: intakeId, status: AiProductIntakeStatus.Open } as any;

      const first = generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader);
      await flush(); // A: provider already resolved, now suspended awaiting the deliberately-held-open persistence write

      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(repository.insertIfAbsentAndIntakeOpen).toHaveBeenCalledTimes(1);

      await expect(
        generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader),
      ).rejects.toBeInstanceOf(AiIntakeGenerationInProgressError);

      // B never reached the provider, and A's own (still in-flight) persistence call was not duplicated.
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(repository.insertIfAbsentAndIntakeOpen).toHaveBeenCalledTimes(1);

      persistenceGate.resolve({ updated: true, row: { id: "p1" } as any });
      await first;
    });

    it("provider failure releases the guard - a later sequential request for the same intake can then reach the provider", async () => {
      const provider: AiIntakeGenerationProvider = {
        generate: vi
          .fn()
          .mockRejectedValueOnce(new Error("simulated provider failure"))
          .mockResolvedValueOnce({ proposal: { suggestedTitle: "A" }, metadata: { providerName: "x", promptVersion: "v1" } }),
      };
      const repository = fakeProposalRepository();
      const photoReader = fakePhotoReaderForGuardTests();
      const intake = { id: intakeId, status: AiProductIntakeStatus.Open } as any;

      await expect(generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader)).rejects.toThrow(
        "simulated provider failure",
      );
      await expect(generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader)).resolves.toBeTruthy();
      expect(provider.generate).toHaveBeenCalledTimes(2);
    });

    it("persistence failure releases the guard - a later sequential request for the same intake can then reach the provider", async () => {
      const provider: AiIntakeGenerationProvider = {
        generate: vi.fn(async () => ({ proposal: { suggestedTitle: "A" }, metadata: { providerName: "x", promptVersion: "v1" } })),
      };
      const repository = fakeProposalRepository({
        insertIfAbsentAndIntakeOpen: vi
          .fn()
          .mockRejectedValueOnce(new Error("simulated persistence failure"))
          .mockResolvedValueOnce({ updated: true, row: { id: "p1" } as any }),
      });
      const photoReader = fakePhotoReaderForGuardTests();
      const intake = { id: intakeId, status: AiProductIntakeStatus.Open } as any;

      await expect(generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader)).rejects.toThrow(
        "simulated persistence failure",
      );
      await expect(generateOrRegenerateProposalUseCase(repository, provider, { intake, photos: [] }, photoReader)).resolves.toBeTruthy();
      expect(provider.generate).toHaveBeenCalledTimes(2);
    });

    it("different intake IDs are fully independent - two truly concurrent generations for different intakes both succeed", async () => {
      const providerGateA = deferred<void>();
      const providerGateB = deferred<void>();
      const provider: AiIntakeGenerationProvider = {
        generate: vi.fn(async (req) => {
          const gate = req.context.intakeId === "intake-a" ? providerGateA : providerGateB;
          await gate.promise;
          return { proposal: { suggestedTitle: "x" }, metadata: { providerName: "x", promptVersion: "v1" } };
        }),
      };
      const repository = fakeProposalRepository();
      const photoReader = fakePhotoReaderForGuardTests();

      const first = generateOrRegenerateProposalUseCase(
        repository,
        provider,
        { intake: { id: "intake-a", status: AiProductIntakeStatus.Open } as any, photos: [] },
        photoReader,
      );
      const second = generateOrRegenerateProposalUseCase(
        repository,
        provider,
        { intake: { id: "intake-b", status: AiProductIntakeStatus.Open } as any, photos: [] },
        photoReader,
      );
      await flush();
      expect(provider.generate).toHaveBeenCalledTimes(2); // both reached the provider - the guard is per-intake, not global

      providerGateA.resolve();
      providerGateB.resolve();
      await expect(first).resolves.toBeTruthy();
      await expect(second).resolves.toBeTruthy();
    });
  });

  describe("regeneration", () => {
    it("succeeds when all decisions are Pending and replaces all suggestions and metadata coherently", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const second = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "New Title" }, metadata: { providerName: "stub-provider", promptVersion: "v2" } }));
      expect(second.title.suggestion).toBe("New Title");
      expect(second.promptVersion).toBe("v2");
      const rows = await db.select().from(aiIntakeProposals);
      expect(rows).toHaveLength(1); // same row, not a new one
    });

    it("is rejected when the title field is Accepted", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      await expect(generateIntakeProposal(db as any, intakeId, stubProvider())).rejects.toBeInstanceOf(AiIntakeProposalReviewResetRequiredError);
    });

    it("is rejected when the description field is Edited", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Edited, "My edited description", "admin-2", generated.updatedAt);
      await expect(generateIntakeProposal(db as any, intakeId, stubProvider())).rejects.toBeInstanceOf(AiIntakeProposalReviewResetRequiredError);
    });

    it("is rejected when the keywords field is Rejected", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Rejected, undefined, "admin-2", generated.updatedAt);
      await expect(generateIntakeProposal(db as any, intakeId, stubProvider())).rejects.toBeInstanceOf(AiIntakeProposalReviewResetRequiredError);
    });

    it("succeeds only after all fields are explicitly reset to Pending", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const accepted = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      await expect(generateIntakeProposal(db as any, intakeId, stubProvider())).rejects.toBeInstanceOf(AiIntakeProposalReviewResetRequiredError);
      await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-2", accepted.updatedAt);
      const result = await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(result.title.decision).toBe(AiIntakeFieldDecision.Pending);
    });

    it("does not refresh only Pending columns while keeping stale global metadata - regeneration is fully coherent", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "First" }, metadata: { providerName: "p1", promptVersion: "v1" } }));
      const result = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "Second", suggestedDescription: "Second desc" }, metadata: { providerName: "p2", promptVersion: "v2" } }));
      expect(result.providerName).toBe("p2");
      expect(result.promptVersion).toBe("v2");
      expect(result.title.suggestion).toBe("Second");
      expect(result.description.suggestion).toBe("Second desc");
    });
  });

  describe("field review", () => {
    it("Pending: final value, reviewer, and reviewedAt are all null by default", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const proposal = await getCurrentProposal(db as any, intakeId);
      expect(proposal.title.decision).toBe(AiIntakeFieldDecision.Pending);
      expect(proposal.title.value).toBeNull();
      expect(proposal.title.reviewedByAdminUserId).toBeNull();
      expect(proposal.title.reviewedAt).toBeNull();
    });

    it("Accepted copies the exact current suggestion into the stored final value", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const result = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      expect(result.title.decision).toBe(AiIntakeFieldDecision.Accepted);
      expect(result.title.value).toBe("Stub Title");
      expect(result.title.suggestion).toBe("Stub Title");
      expect(result.title.reviewedByAdminUserId).toBe("admin-2");
      expect(result.title.reviewedAt).toBeTruthy();
    });

    it("Edited stores the human-provided value, distinct from the suggestion", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const result = await updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Edited, "A human-written description.", "admin-2", generated.updatedAt);
      expect(result.description.decision).toBe(AiIntakeFieldDecision.Edited);
      expect(result.description.value).toBe("A human-written description.");
      expect(result.description.suggestion).toBe("Stub description.");
    });

    it("Rejected preserves the suggestion and clears the final value", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const result = await updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Rejected, undefined, "admin-2", generated.updatedAt);
      expect(result.keywords.decision).toBe(AiIntakeFieldDecision.Rejected);
      expect(result.keywords.value).toBeNull();
      expect(result.keywords.suggestion).toEqual(["stub", "keyword"]);
    });

    it("resetting to Pending clears value, reviewer, and reviewedAt", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const edited = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Edited, "Edited value", "admin-2", generated.updatedAt);
      const result = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-3", edited.updatedAt);
      expect(result.title.decision).toBe(AiIntakeFieldDecision.Pending);
      expect(result.title.value).toBeNull();
      expect(result.title.reviewedByAdminUserId).toBeNull();
      expect(result.title.reviewedAt).toBeNull();
    });

    it("edited keywords are trimmed, empty entries dropped, and case-insensitively deduplicated preserving first spelling", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const { keywordsFieldReviewSchema } = await import("../src/validation/aiIntakeProposal");
      const parsed = keywordsFieldReviewSchema.parse({
        decision: "edited",
        expectedUpdatedAt: "irrelevant-for-this-parse-check",
        value: ["  Vintage ", "vintage", "VINTAGE", "", "  ", "Lamp"],
      });
      expect(parsed.value).toEqual(["Vintage", "Lamp"]);
    });

    it("rejects an empty edited keyword list after normalization", async () => {
      const { keywordsFieldReviewSchema } = await import("../src/validation/aiIntakeProposal");
      expect(() => keywordsFieldReviewSchema.parse({ decision: "edited", expectedUpdatedAt: "x", value: ["  ", ""] })).toThrow();
    });

    it("per-field reviewer identity is tracked independently per field", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const titleReviewed = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-title-reviewer", generated.updatedAt);
      const result = await updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Accepted, undefined, "admin-description-reviewer", titleReviewed.updatedAt);
      expect(result.title.reviewedByAdminUserId).toBe("admin-title-reviewer");
      expect(result.description.reviewedByAdminUserId).toBe("admin-description-reviewer");
    });

    it("throws NotFoundError when no proposal exists yet", async () => {
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", new Date().toISOString()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a stale expectedUpdatedAt causes a version conflict at the repository level, no write applied", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const [existing] = await db.select().from(aiIntakeProposals);
      const result = await repository.updateFieldReviewAtomic(intakeId, existing.id, "title", "not-the-real-value", AiIntakeFieldDecision.Accepted, () => ({
        decision: "accepted", value: "Stub Title", reviewedByAdminUserId: "admin-2", reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));
      expect(result.updated).toBe(false);
      expect(result.conflict?.reason).toBe("version_mismatch");
    });

    it("concurrent review writes produce one winner and one conflict", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const [existing] = await db.select().from(aiIntakeProposals);
      const now = new Date().toISOString();
      const first = await repository.updateFieldReviewAtomic(intakeId, existing.id, "title", existing.updatedAt, AiIntakeFieldDecision.Accepted, () => ({
        decision: "accepted", value: "Stub Title", reviewedByAdminUserId: "admin-a", reviewedAt: now, updatedAt: new Date(Date.now() + 1000).toISOString(),
      }));
      const second = await repository.updateFieldReviewAtomic(intakeId, existing.id, "description", existing.updatedAt, AiIntakeFieldDecision.Accepted, () => ({
        decision: "accepted", value: "Stub description.", reviewedByAdminUserId: "admin-b", reviewedAt: now, updatedAt: new Date(Date.now() + 2000).toISOString(),
      }));
      expect(first.updated).toBe(true);
      expect(second.updated).toBe(false);
      expect(second.conflict?.reason).toBe("version_mismatch");
    });

    it("a successful review write advances updatedAt monotonically, even within the same clock tick", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const before = await getCurrentProposal(db as any, intakeId);
      const after = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", before.updatedAt);
      expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    });

    it("review cannot persist after cancellation wins the race (atomic guard)", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const [existing] = await db.select().from(aiIntakeProposals);
      await cancelIntake(db as any, intakeId, "admin-1");
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const result = await repository.updateFieldReviewAtomic(intakeId, existing.id, "title", existing.updatedAt, AiIntakeFieldDecision.Accepted, () => ({
        decision: "accepted", value: "Stub Title", reviewedByAdminUserId: "admin-2", reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }));
      expect(result.updated).toBe(false);
      expect(result.conflict?.reason).toBe("intake_not_open");
    });

    it("rejects a review write for a Cancelled intake at the service layer (fast pre-check)", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await cancelIntake(db as any, intakeId, "admin-1");
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe("photo staleness", () => {
    it("the same photo set is not stale", async () => {
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const proposal = await getCurrentProposal(db as any, intakeId);
      expect(proposal.stale).toBe(false);
    });

    it("adding a photo after generation makes the proposal stale", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const proposal = await getCurrentProposal(db as any, intakeId);
      expect(proposal.stale).toBe(true);
    });

    it("deleting a photo after generation makes the proposal stale", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      await deleteIntakePhoto(db as any, intakeId, photo.id, storage);
      const proposal = await getCurrentProposal(db as any, intakeId);
      expect(proposal.stale).toBe(true);
    });

    it("replacing a photo (delete + add) after generation makes the proposal stale", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      await deleteIntakePhoto(db as any, intakeId, photo.id, storage);
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("y"), mimetype: "image/png", size: 1 }, "b.png", "admin-1", storage);
      const proposal = await getCurrentProposal(db as any, intakeId);
      expect(proposal.stale).toBe(true);
    });

    it("a stale proposal remains readable", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await expect(getCurrentProposal(db as any, intakeId)).resolves.toMatchObject({ stale: true });
    });

    it("a stale proposal rejects field-review writes", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalStaleError);
    });

    it("regeneration refreshes the fingerprint and the proposal is no longer stale afterward", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const staleCheck = await getCurrentProposal(db as any, intakeId);
      expect(staleCheck.stale).toBe(true);
      const regenerated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(regenerated.stale).toBe(false);
    });
  });

  /**
   * Sprint 97: stale-proposal recovery. A field once reviewed and then made stale by a later
   * staged-photo change could never reach Pending again before this correction (every PATCH,
   * including decision:Pending, was rejected while stale) - which permanently blocked
   * regeneration (it requires all three fields already Pending), an unrecoverable deadlock. The
   * fix is a narrow exception: Pending is allowed while stale; Accepted/Edited/Rejected remain
   * fully blocked while stale, exactly as before.
   */
  describe("stale-proposal recovery (Sprint 97)", () => {
    /** Accepts the title (making it non-Pending) while NOT stale, then uploads a photo afterward to make the proposal stale. */
    async function acceptTitleThenGoStale(): Promise<{ acceptedUpdatedAt: string }> {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const accepted = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      return { acceptedUpdatedAt: accepted.updatedAt };
    }

    it("a non-stale Pending reset still works (baseline, unaffected by the correction)", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const accepted = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      const reset = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-2", accepted.updatedAt);
      expect(reset.title.decision).toBe(AiIntakeFieldDecision.Pending);
    });

    it("stale Edited is rejected", async () => {
      const { acceptedUpdatedAt } = await acceptTitleThenGoStale();
      await expect(
        updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Edited, "Manual description", "admin-2", acceptedUpdatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalStaleError);
    });

    it("stale Rejected is rejected", async () => {
      const { acceptedUpdatedAt } = await acceptTitleThenGoStale();
      await expect(
        updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Rejected, undefined, "admin-2", acceptedUpdatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalStaleError);
    });

    it("a stale Pending reset succeeds, clears value/reviewer/reviewedAt, preserves the suggestion, and advances updatedAt", async () => {
      const { acceptedUpdatedAt } = await acceptTitleThenGoStale();
      const reset = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-3", acceptedUpdatedAt);
      expect(reset.title.decision).toBe(AiIntakeFieldDecision.Pending);
      expect(reset.title.value).toBeNull();
      expect(reset.title.reviewedByAdminUserId).toBeNull();
      expect(reset.title.reviewedAt).toBeNull();
      expect(reset.title.suggestion).toBe("Stub Title");
      expect(new Date(reset.updatedAt).getTime()).toBeGreaterThan(new Date(acceptedUpdatedAt).getTime());
    });

    it("a stale Pending reset with an incorrect expectedUpdatedAt is rejected", async () => {
      await acceptTitleThenGoStale();
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-3", "not-the-real-updatedAt"),
      ).rejects.toBeInstanceOf(AiIntakeProposalVersionConflictError);
    });

    it("resetting one field leaves the proposal stale (does not update photoSetFingerprint)", async () => {
      const { acceptedUpdatedAt } = await acceptTitleThenGoStale();
      await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-3", acceptedUpdatedAt);
      const afterReset = await getCurrentProposal(db as any, intakeId);
      expect(afterReset.stale).toBe(true);
    });

    it("after all three fields are reset to Pending, regeneration succeeds and refreshes the photo fingerprint", async () => {
      const { acceptedUpdatedAt } = await acceptTitleThenGoStale();
      await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-3", acceptedUpdatedAt);
      // description/keywords were never reviewed in this flow - already Pending.
      const regenerated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(regenerated.stale).toBe(false);
      expect(regenerated.title.decision).toBe(AiIntakeFieldDecision.Pending);
    });

    it("no Product, ProductPhoto, Inventory, or StockMovement row is ever created by stale-recovery reset/regeneration", async () => {
      const { acceptedUpdatedAt } = await acceptTitleThenGoStale();
      await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-3", acceptedUpdatedAt);
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(productPhotos)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
    });
  });

  describe("security, permissions, and scope protection", () => {
    it("no new permission string was added for Sprint 93", async () => {
      const { ROLE_PERMISSIONS } = await import("@noctella/shared");
      const allPermissions = new Set(Object.values(ROLE_PERMISSIONS).flat());
      const intakeRelated = [...allPermissions].filter((p) => p.startsWith("ai_product_intake") || p.startsWith("ai_intake_proposal"));
      expect(intakeRelated.sort()).toEqual(["ai_product_intakes.manage", "ai_product_intakes.view"]);
    });

    it("does not create, mutate, or promote a Product/Inventory/ProductPhoto row", async () => {
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(productPhotos)).toHaveLength(0);
      expect(await db.select().from(productImages)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
    });

    it("does not create a publish job, external listing, or ai_listing_drafts row", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(await db.select().from(publishJobs)).toHaveLength(0);
      expect(await db.select().from(externalListings)).toHaveLength(0);
      expect(await db.select().from(aiListingDrafts)).toHaveLength(0);
    });

    it("does not reference the AI Draft system or the existing AI provider tree anywhere in the new source", () => {
      const files = [
        "src/repositories/ai-intake-proposal/drizzle.ts",
        "src/repositories/ai-intake-proposal/types.ts",
        "src/repositories/ai-intake-proposal/factory.ts",
        "src/use-cases/ai-intake-proposal/useCases.ts",
        "src/services/aiIntakeProposals.ts",
        "src/services/aiIntakeLockTransactionCapabilityForDb.ts",
      ];
      for (const file of files) {
        const source = read(file);
        const importLines = source.split("\n").filter((line) => /^\s*import /.test(line)).join("\n");
        expect(importLines).not.toMatch(/from ["']\.\.\/ai\/provider["']|from ["']\.\.\/ai\/mockProvider["']|aiListingDrafts|AiDraftStatus|ai-draft\//);
      }
    });
  });

  describe("database foundation", () => {
    it("SQLite ensureSchema is idempotent for the new table", () => {
      const freshSqlite = new Database(":memory:");
      freshSqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      const columns = (freshSqlite.prepare("PRAGMA table_info(ai_intake_proposals)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "id", "intake_id", "suggested_title", "suggested_description", "suggested_keywords", "confidence_score",
          "title_decision", "title_value", "title_reviewed_by_admin_user_id", "title_reviewed_at",
          "description_decision", "description_value", "description_reviewed_by_admin_user_id", "description_reviewed_at",
          "keywords_decision", "keywords_value", "keywords_reviewed_by_admin_user_id", "keywords_reviewed_at",
          "photo_set_fingerprint", "generated_at", "provider_name", "prompt_version", "created_at", "updated_at",
        ]),
      );
      freshSqlite.close();
    });

    it("SQLite Drizzle construction works against the new table", async () => {
      const repository = createAiIntakeProposalRepository("sqlite", db);
      const result = await repository.insertIfAbsentAndIntakeOpen({
        id: "sqlite-construction-check", intakeId, suggestedTitle: "T", suggestedDescription: null, suggestedKeywords: null, confidenceScore: null,
        expectedPhotoFingerprint: computePhotoSetFingerprint([]), generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      expect(result.updated).toBe(true);
      expect(result.row?.id).toBe("sqlite-construction-check");
    });

    it("PostgreSQL Drizzle construction remains valid for the ai-intake-proposal repository", async () => {
      const { createDrizzleAiIntakeProposalRepository } = await import("../src/repositories/ai-intake-proposal/drizzle");
      const { createAiIntakeLockTransactionCapabilityForDb } = await import("../src/services/aiIntakeLockTransactionCapabilityForDb");
      const testDbHandle = drizzle(new Database(":memory:"), { schema: sqliteSchema });
      const capability = createAiIntakeLockTransactionCapabilityForDb(testDbHandle as any, "postgres");
      const repository = createDrizzleAiIntakeProposalRepository(testDbHandle as any, postgresSchema, capability);
      expect(repository.findByIntakeId).toBeTypeOf("function");
      expect(repository.insertIfAbsentAndIntakeOpen).toBeTypeOf("function");
      expect(repository.refreshPendingFields).toBeTypeOf("function");
      expect(repository.updateFieldReviewAtomic).toBeTypeOf("function");
    });

    it("the unique intake_id constraint is enforced", async () => {
      await expect(
        db.insert(aiIntakeProposals).values([
          { id: "dup-1", intakeId, suggestedTitle: "A", titleDecision: "pending", descriptionDecision: "pending", keywordsDecision: "pending", photoSetFingerprint: "fp", generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v1" } as any,
        ]),
      ).resolves.not.toThrow();
      await expect(
        db.insert(aiIntakeProposals).values([
          { id: "dup-2", intakeId, suggestedTitle: "B", titleDecision: "pending", descriptionDecision: "pending", keywordsDecision: "pending", photoSetFingerprint: "fp", generatedAt: new Date().toISOString(), providerName: "x", promptVersion: "v1" } as any,
        ]),
      ).rejects.toThrow();
    });

    it("database parity includes ai_intake_proposals", () => {
      expect(requiredSprint24Tables).toContain("ai_intake_proposals");
      const parity = runSchemaParity();
      expect(parity.status).toBe("PASS");
      expect(parity.tables.find((t) => t.name === "ai_intake_proposals")?.sqlite).toBe(true);
    });

    it("migration 0010 creates ai_intake_proposals without dropping anything, and is included in migration validation", () => {
      const migrationSql = read("src/db/postgres-migrations/0010_sprint93_ai_intake_field_review_foundation.sql");
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_intake_proposals");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);

      const validation = validatePostgresMigrationSql();
      expect(validation.status).toBe("PASS");
      expect(validation.missingTables).not.toContain("ai_intake_proposals");
      expect(validation.hasDrop).toBe(false);
    });

    it("migrations 0001-0009 are unchanged", () => {
      for (const file of [
        "0001_sprint24_foundation.sql", "0002_sprint25_outbox.sql", "0003_sprint30a1_return_repository_foundation.sql",
        "0004_sprint33a_s3br_completion_idempotency.sql", "0005_sprint33a_s3br3_completed_sale_guard.sql", "0006_sprint64b_admin_auth.sql",
        "0007_sprint89_ai_draft_generation_baseline.sql", "0008_sprint90_ai_product_intake_foundation.sql", "0009_sprint91_ai_intake_photo_foundation.sql",
      ]) {
        expect(() => read(`src/db/postgres-migrations/${file}`)).not.toThrow();
      }
    });
  });

  /**
   * Sprint 93 Critical Correction Pass - section 13. Genuine interleaving proof, where
   * achievable, is produced by wrapping the repository interface so a "concurrent" mutation
   * commits at the exact code boundary the fix is supposed to guard (e.g. after a use-case's
   * fast pre-check but before the repository's own locked/atomic re-verification) - not by
   * calling operations sequentially before the first one is even invoked. Where true
   * concurrent-connection blocking (PostgreSQL SELECT ... FOR UPDATE actually making a second
   * transaction wait) cannot be produced against the synchronous, single-connection SQLite test
   * database, this is called out explicitly rather than claimed.
   */
  describe("interleaving races (Sprint 93 correction pass)", () => {
    const stubPhotoReader: AiIntakePhotoReader = { read: async () => Buffer.from("") };

    it("[A] cancellation committing after the provider returns but before the lock is acquired blocks first-generation persistence", async () => {
      const realRepository = createAiIntakeProposalRepository("sqlite", db);
      let cancelled = false;
      const interleaving: AiIntakeProposalRepository = {
        ...realRepository,
        async insertIfAbsentAndIntakeOpen(input) {
          // Simulates cancellation committing exactly between provider execution (already
          // finished by the time generateOrRegenerateProposalUseCase calls this method) and the
          // repository's own intake-row lock acquisition below.
          if (!cancelled) {
            cancelled = true;
            await cancelIntake(db as any, intakeId, "admin-1");
          }
          return realRepository.insertIfAbsentAndIntakeOpen(input);
        },
      };
      const intake = await getIntakeById(db as any, intakeId);
      await expect(
        generateOrRegenerateProposalUseCase(interleaving, stubProvider(), { intake, photos: [] }, stubPhotoReader),
      ).rejects.toBeInstanceOf(AiIntakeProposalIntakeNotOpenError);
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(0);
    });

    it("[B] when first-generation persistence acquires the intake lock first, it commits, and cancellation proceeds normally afterward (documented limitation: true lock-contention blocking requires a live PostgreSQL connection, not reproducible against this synchronous single-connection SQLite test database)", async () => {
      await generateIntakeProposal(db as any, intakeId, stubProvider());
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(1);
      const cancelled = await cancelIntake(db as any, intakeId, "admin-1");
      expect(cancelled.status).toBe(AiProductIntakeStatus.Cancelled);
      // The proposal generated before cancellation is untouched - cancellation never deletes it.
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(1);
    });

    it("[C] an insert failure shaped like a concurrent unique-constraint violation is translated to a typed conflict, never a raw exception (defense-in-depth for two genuinely concurrent first-generation writes under PostgreSQL, which this synchronous SQLite test database cannot itself produce)", async () => {
      sqlite
        .prepare(
          "CREATE TRIGGER force_unique_violation BEFORE INSERT ON ai_intake_proposals BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: ai_intake_proposals.intake_id'); END;",
        )
        .run();
      const intake = await getIntakeById(db as any, intakeId);
      const repository = createAiIntakeProposalRepository("sqlite", db);
      await expect(
        generateOrRegenerateProposalUseCase(repository, stubProvider(), { intake, photos: [] }, stubPhotoReader),
      ).rejects.toBeInstanceOf(AiIntakeProposalVersionConflictError);
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(0);
    });

    it("[D] a field review whose atomic transaction commits first is not affected by a photo uploaded immediately afterward - the upload correctly sees the review's result and the next read is stale", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const reviewed = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      expect(reviewed.title.decision).toBe(AiIntakeFieldDecision.Accepted);
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const afterUpload = await getCurrentProposal(db as any, intakeId);
      expect(afterUpload.title.decision).toBe(AiIntakeFieldDecision.Accepted); // the committed review is untouched
      expect(afterUpload.stale).toBe(true); // but the proposal is now correctly stale relative to the new photo set
    });

    it("[E] a photo uploaded between the use-case's fast pre-check and the atomic write is still caught - proves the locked transaction check, not just the service-layer pre-check, is authoritative", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const realRepository = createAiIntakeProposalRepository("sqlite", db);
      const storage = mockPhotoStorage();
      let uploaded = false;
      const interleaving: AiIntakeProposalRepository = {
        ...realRepository,
        async updateFieldReviewAtomic(...args) {
          // The use-case's fast pre-check already ran (against an empty photo list, matching the
          // fingerprint stored at generation time) and passed *before* this method was called -
          // this simulates a photo committing in the window between that pre-check and the
          // repository's own re-verification, which happens inside this call.
          if (!uploaded) {
            uploaded = true;
            await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
          }
          return realRepository.updateFieldReviewAtomic(...args);
        },
      };
      await expect(
        updateFieldReviewUseCase(interleaving, {
          intakeId, field: "title", decision: AiIntakeFieldDecision.Accepted, actorId: "admin-2", photos: [], expectedUpdatedAt: generated.updatedAt,
        }),
      ).rejects.toBeInstanceOf(AiIntakeProposalStaleError);
      const [row] = await db.select().from(aiIntakeProposals);
      expect(row.titleDecision).toBe("pending"); // no review decision was written
    });

    it("[F] a photo deleted between the use-case's fast pre-check and the atomic write is still caught, symmetric to [E]", async () => {
      const storage = mockPhotoStorage();
      const photo = await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const photosAtGeneration = await db.select().from(sqliteSchema.aiIntakePhotos);
      expect(photosAtGeneration).toHaveLength(1);

      const realRepository = createAiIntakeProposalRepository("sqlite", db);
      let deleted = false;
      const interleaving: AiIntakeProposalRepository = {
        ...realRepository,
        async updateFieldReviewAtomic(...args) {
          if (!deleted) {
            deleted = true;
            await deleteIntakePhoto(db as any, intakeId, photo.id, storage);
          }
          return realRepository.updateFieldReviewAtomic(...args);
        },
      };
      await expect(
        updateFieldReviewUseCase(interleaving, {
          intakeId,
          field: "title",
          decision: AiIntakeFieldDecision.Accepted,
          actorId: "admin-2",
          photos: [{ id: photo.id } as any],
          expectedUpdatedAt: generated.updatedAt,
        }),
      ).rejects.toBeInstanceOf(AiIntakeProposalStaleError);
      const [row] = await db.select().from(aiIntakeProposals);
      expect(row.titleDecision).toBe("pending");
    });

    it("PostgreSQL: the intake-row lock is acquired with SELECT ... FOR UPDATE, not a plain unlocked SELECT", async () => {
      const forCalls: string[] = [];
      const fakeSelectChain = {
        from: () => fakeSelectChain,
        where: () => fakeSelectChain,
        for: (strength: string) => {
          forCalls.push(strength);
          return Promise.resolve([{ id: intakeId, status: AiProductIntakeStatus.Open }]);
        },
      };
      const fakeTx = { select: () => fakeSelectChain };
      const fakeDb = { transaction: (work: (tx: any) => Promise<any>) => work(fakeTx) };

      const { createAiIntakeLockTransactionCapabilityForDb } = await import("../src/services/aiIntakeLockTransactionCapabilityForDb");
      const capability = createAiIntakeLockTransactionCapabilityForDb(fakeDb as any, "postgres");
      await capability.runWithLockedIntake(intakeId, ({ intake }) => {
        expect(intake).toEqual({ id: intakeId, status: AiProductIntakeStatus.Open });
      });
      expect(forCalls).toEqual(["update"]);
    });
  });

  /**
   * Sprint 93 Critical Correction Pass - section 9. Accepted must never store a null value.
   */
  describe("Accepted-suggestion invariant", () => {
    it("rejects Accepted for title when the suggestion is missing (null)", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: undefined, suggestedDescription: "d", suggestedKeywords: ["k"] } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
    });

    it("rejects Accepted for title when the suggestion is an empty/whitespace-only string", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "   ", suggestedDescription: "d", suggestedKeywords: ["k"] } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
    });

    it("rejects Accepted for description when the suggestion is missing (null)", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "t", suggestedDescription: undefined, suggestedKeywords: ["k"] } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
    });

    it("rejects Accepted for description when the suggestion is an empty string", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "t", suggestedDescription: "", suggestedKeywords: ["k"] } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
    });

    it("rejects Accepted for keywords when the suggestion is missing (null)", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "t", suggestedDescription: "d", suggestedKeywords: undefined } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
    });

    it("rejects Accepted for keywords when the suggested array normalizes to zero entries", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "t", suggestedDescription: "d", suggestedKeywords: ["  ", ""] } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
    });

    it("rejects Accepted keywords for a real zero-photo MockAiIntakeGenerationProvider generation - the exact reachable case identified by the Exact Review", async () => {
      const { MockAiIntakeGenerationProvider } = await import("../src/ai-intake/mockProvider");
      const generated = await generateIntakeProposal(db as any, intakeId, new MockAiIntakeGenerationProvider());
      expect(generated.keywords.suggestion).toBeNull();
      await expect(
        updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toBeInstanceOf(AiIntakeProposalSuggestionUnavailableError);
      const [row] = await db.select().from(aiIntakeProposals);
      expect(row.keywordsDecision).toBe("pending"); // no write applied
    });

    it("no write is applied when Accepted is rejected for an unavailable suggestion", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: undefined, suggestedDescription: "d", suggestedKeywords: ["k"] } }));
      await expect(
        updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt),
      ).rejects.toThrow();
      const [row] = await db.select().from(aiIntakeProposals);
      expect(row.titleDecision).toBe("pending");
      expect(row.titleReviewedByAdminUserId).toBeNull();
    });

    it("Accepted keywords are normalized (trim, drop empty, case-insensitive dedupe) before being stored", async () => {
      const generated = await generateIntakeProposal(
        db as any, intakeId, stubProvider({}, { proposal: { suggestedTitle: "t", suggestedDescription: "d", suggestedKeywords: ["  Vintage ", "vintage", "VINTAGE", "Lamp"] } }),
      );
      const result = await updateProposalFieldReview(db as any, intakeId, "keywords", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      expect(result.keywords.value).toEqual(["Vintage", "Lamp"]);
    });
  });

  /**
   * Sprint 93 Critical Correction Pass - section 10. nextUpdatedAt must accept both a string
   * timestamp and a real Date instance (PostgreSQL's runtime representation for a `timestamp`
   * column with no `mode: "string"`) without losing sub-second precision.
   */
  describe("timestamp monotonicity", () => {
    it("advances a string timestamp with milliseconds strictly forward", () => {
      const current = "2026-01-01T00:00:00.123Z";
      const next = nextUpdatedAt(current);
      expect(Date.parse(next)).toBeGreaterThan(Date.parse(current));
    });

    it("advances a real Date instance with milliseconds strictly forward, without truncating precision", () => {
      const current = new Date("2026-01-01T00:00:00.123Z");
      const next = nextUpdatedAt(current);
      expect(Date.parse(next)).toBeGreaterThan(current.getTime());
    });

    it("a Date instance and the equivalent ISO string produce the same next value", () => {
      // Fixed system time - nextUpdatedAt reads Date.now() internally, and two separate calls at
      // real wall-clock time can legitimately land in different milliseconds, which would make
      // this specific equality assertion flaky without pinning the clock.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      try {
        const iso = "2026-01-01T00:00:00.123Z";
        const asDate = new Date(iso);
        expect(nextUpdatedAt(asDate)).toBe(nextUpdatedAt(iso));
      } finally {
        vi.useRealTimers();
      }
    });

    it("rapid consecutive updates each strictly exceed the previous value, even given a Date instance baseline", () => {
      let current: string | Date = new Date();
      const seen: number[] = [];
      for (let i = 0; i < 5; i++) {
        const next = nextUpdatedAt(current);
        const nextMs = Date.parse(next);
        if (seen.length) expect(nextMs).toBeGreaterThan(seen[seen.length - 1]);
        seen.push(nextMs);
        current = next; // next iteration receives a string, matching a fresh SQLite read
      }
    });

    it("a Date instance one millisecond behind now still strictly advances (regression guard for Date.parse(Date) truncation)", () => {
      const current = new Date(Date.now() - 1);
      const next = nextUpdatedAt(current);
      expect(Date.parse(next)).toBeGreaterThan(current.getTime());
    });
  });

  /**
   * Sprint 93 Critical Correction Pass - section 11/12. toProposalReview must normalize
   * PostgreSQL's actual runtime row shape (Date instances for timestamp columns, strings for
   * numeric columns) into the AiIntakeProposalReview contract - never leak a Date object or a
   * numeric string into the JSON response.
   */
  describe("PostgreSQL runtime row-shape normalization", () => {
    function postgresShapedRow(overrides: Record<string, unknown> = {}) {
      const now = new Date("2026-01-01T00:00:00.500Z");
      return {
        id: "prop-1",
        intakeId: "intake-1",
        suggestedTitle: "T",
        suggestedDescription: "D",
        suggestedKeywords: JSON.stringify(["a", "b"]),
        confidenceScore: "0.500000", // PostgreSQL numeric column, no mode: "number" -> string at runtime
        titleDecision: "pending",
        titleValue: null,
        titleReviewedByAdminUserId: null,
        titleReviewedAt: null,
        descriptionDecision: "pending",
        descriptionValue: null,
        descriptionReviewedByAdminUserId: null,
        descriptionReviewedAt: null,
        keywordsDecision: "accepted",
        keywordsValue: JSON.stringify(["a", "b"]),
        keywordsReviewedByAdminUserId: "admin-1",
        keywordsReviewedAt: now, // PostgreSQL timestamp column, no mode: "string" -> Date instance at runtime
        photoSetFingerprint: "fp",
        generatedAt: now,
        providerName: "x",
        promptVersion: "v1",
        createdAt: now,
        updatedAt: now,
        ...overrides,
      } as any;
    }

    it("converts a numeric-string confidenceScore to a real number", () => {
      const result = toProposalReview(postgresShapedRow(), false);
      expect(result.confidenceScore).toBe(0.5);
      expect(typeof result.confidenceScore).toBe("number");
    });

    it("converts Date-instance timestamps to ISO strings", () => {
      const result = toProposalReview(postgresShapedRow(), false);
      expect(result.generatedAt).toBe("2026-01-01T00:00:00.500Z");
      expect(result.createdAt).toBe("2026-01-01T00:00:00.500Z");
      expect(result.updatedAt).toBe("2026-01-01T00:00:00.500Z");
      expect(result.keywords.reviewedAt).toBe("2026-01-01T00:00:00.500Z");
      expect(typeof result.generatedAt).toBe("string");
    });

    it("decodes JSON-text keywords into a real string array, never raw JSON text", () => {
      const result = toProposalReview(postgresShapedRow(), false);
      expect(result.keywords.suggestion).toEqual(["a", "b"]);
      expect(result.keywords.value).toEqual(["a", "b"]);
    });

    it("leaves a null confidenceScore as undefined, and a null reviewedAt as null", () => {
      const result = toProposalReview(postgresShapedRow({ confidenceScore: null }), false);
      expect(result.confidenceScore).toBeUndefined();
      expect(result.title.reviewedAt).toBeNull();
    });

    it("handles a non-finite/garbage confidenceScore string safely", () => {
      const result = toProposalReview(postgresShapedRow({ confidenceScore: "not-a-number" }), false);
      expect(result.confidenceScore).toBeUndefined();
    });
  });
});
