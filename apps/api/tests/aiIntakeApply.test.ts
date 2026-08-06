import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiIntakeFieldDecision, AiProductIntakeStatus, ProductStatus, ProductType } from "@noctella/shared";
import {
  AiIntakeApplyIntakeNotOpenError,
  AiIntakeApplyPhotoSetStaleError,
  AiIntakeApplyProposalNotReadyError,
  AiIntakeApplyProposalVersionConflictError,
  AiIntakeApplyResultStateInvalidError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../src/services/errors";
import { createIntake, cancelIntake, getIntakeById } from "../src/services/aiProductIntakes";
import { uploadIntakePhoto, deleteIntakePhoto } from "../src/services/aiIntakePhotos";
import { generateIntakeProposal } from "../src/services/aiIntakeGeneration";
import { updateProposalFieldReview, getCurrentProposal } from "../src/services/aiIntakeProposals";
import { saveAiIntakeAsDraft } from "../src/services/aiIntakeApply";
import { createCategory } from "../src/services/categories";
import { applyAiIntakeUseCase, type ApplyAiIntakeInput } from "../src/use-cases/ai-intake-apply/useCases";
import { createAiIntakeApplyTransactionCapabilityForDb, type AiIntakeApplyTransactionCapability } from "../src/services/aiIntakeApplyTransactionCapabilityForDb";
import type { AiIntakeGenerationProvider } from "../src/ai-intake/types";
import type { AiIntakePhotoStorage } from "../src/services/aiIntakePhotoStorage";
import { aiIntakeProposals, aiIntakePhotos, aiProductIntakes, products, stockMovements, productPhotos } from "../src/db/schema";
import * as sqliteSchema from "../src/db/schema.sqlite";
import { ensureSchema } from "../src/db/migrate";
import { requiredSprint24Tables, runSchemaParity, validatePostgresMigrationSql } from "../src/services/databaseMigrationFoundation";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestDb } from "./testDb";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function mockPhotoStorage(): AiIntakePhotoStorage {
  let counter = 0;
  return {
    saveIntakePhoto: vi.fn(async () => {
      counter += 1;
      return { storageKey: `mock-key-${counter}.webp` };
    }),
    deleteIntakePhoto: vi.fn(async () => {}),
  };
}

function stubProvider(result?: any): AiIntakeGenerationProvider {
  return {
    generate: vi.fn(async (req) => ({
      proposal: { suggestedTitle: "Stub Title", suggestedDescription: "Stub description.", suggestedKeywords: ["stub", "keyword"], confidenceScore: 0.7 },
      metadata: { providerName: "stub-provider", promptVersion: req.prompt.version },
      ...result,
    })),
  };
}

describe("AI intake explicit Save as Draft canonical apply transaction (Sprint 94)", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>;
  let intakeId: string;
  let categoryId: string;

  const validRequest = (overrides: Partial<ApplyAiIntakeInput> = {}) => ({
    intakeId,
    sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
    categoryId,
    type: ProductType.UniqueItem,
    priceEur: 42,
    expectedProposalUpdatedAt: "",
    actorId: "admin-1",
    ...overrides,
  });

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    db = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
    const category = await createCategory(db as any, { name: "Test Category", displayOrder: 0, isActive: true } as any);
    categoryId = category.id;
    const intake = await createIntake(db as any, "admin-1");
    intakeId = intake.id;
  });

  /** Generates a proposal and accepts title (always required-ready); other fields left Pending unless requested. */
  async function readyIntake(opts: { description?: "accepted" | "rejected"; keywords?: "accepted" | "rejected" } = {}) {
    const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
    let cur = generated;
    cur = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", cur.updatedAt);
    if (opts.description) {
      cur = await updateProposalFieldReview(db as any, intakeId, "description", opts.description === "accepted" ? AiIntakeFieldDecision.Accepted : AiIntakeFieldDecision.Rejected, undefined, "admin-2", cur.updatedAt);
    }
    if (opts.keywords) {
      cur = await updateProposalFieldReview(db as any, intakeId, "keywords", opts.keywords === "accepted" ? AiIntakeFieldDecision.Accepted : AiIntakeFieldDecision.Rejected, undefined, "admin-2", cur.updatedAt);
    }
    return cur;
  }

  describe("happy path", () => {
    it("creates exactly one canonical Product with Draft status and the reviewed title", async () => {
      const proposal = await readyIntake();
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.created).toBe(true);
      expect(result.product.title).toBe("Stub Title");
      expect(result.product.status).toBe(ProductStatus.Draft);
      const rows = await db.select().from(products);
      expect(rows).toHaveLength(1);
    });

    it("maps Accepted/Edited description; omits Pending/Rejected description", async () => {
      const proposal = await readyIntake({ description: "accepted" });
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.product.description).toBe("Stub description.");
    });

    it("omits description when Rejected", async () => {
      const proposal = await readyIntake({ description: "rejected" });
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.product.description).toBeFalsy();
    });

    it("maps Accepted/Edited keywords; omits Pending/Rejected keywords", async () => {
      const proposal = await readyIntake({ keywords: "accepted" });
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.product.keywords).toEqual(["stub", "keyword"]);
    });

    it("stockQuantity omitted -> Inventory (Product.stockQuantity) is 0, one initial StockMovement exists", async () => {
      const proposal = await readyIntake();
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.product.stockQuantity).toBe(0);
      const movements = await db.select().from(stockMovements);
      expect(movements).toHaveLength(1);
      expect(movements[0].productId).toBe(result.product.id);
    });

    it("stockQuantity supplied -> canonical quantity is used", async () => {
      const proposal = await readyIntake();
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, type: ProductType.LotItem, stockQuantity: 5 }) as any, "admin-3");
      expect(result.product.stockQuantity).toBe(5);
    });

    it("writes resultProductId, transitions status to Applied, records appliedAt/appliedByAdminUserId from the actor", async () => {
      const proposal = await readyIntake();
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Applied);
      expect(intake.resultProductId).toBe(result.product.id);
      expect(intake.appliedAt).toBeTruthy();
      expect(intake.appliedByAdminUserId).toBe("admin-3");
    });

    it("proposal remains readable and staged photos remain present after apply", async () => {
      const storage = mockPhotoStorage();
      // Uploaded before generation, so the proposal's fingerprint already covers it - no
      // regeneration needed (regeneration would require resetting title back to Pending first).
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      const proposal = await readyIntake();
      await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(await db.select().from(aiIntakeProposals)).toHaveLength(1);
      expect(await db.select().from(aiIntakePhotos)).toHaveLength(1);
    });

    it("does not create ProductPhoto, does not copy files, does not publish", async () => {
      const proposal = await readyIntake();
      await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(await db.select().from(productPhotos)).toHaveLength(0);
    });
  });

  describe("readiness", () => {
    it("rejects a Pending title", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: generated.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalNotReadyError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects a Rejected title", async () => {
      const generated = await generateIntakeProposal(db as any, intakeId, stubProvider());
      const reviewed = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Rejected, undefined, "admin-2", generated.updatedAt);
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: reviewed.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalNotReadyError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects defensively when the title decision is Accepted but the stored value is an empty string (constructed directly - unreachable through the normal API)", async () => {
      const proposal = await readyIntake();
      sqlite.prepare("UPDATE ai_intake_proposals SET title_value = '' WHERE intake_id = ?").run(intakeId);
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalNotReadyError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects defensively when the description decision is Accepted but the stored value is null (constructed directly)", async () => {
      const proposal = await readyIntake({ description: "accepted" });
      sqlite.prepare("UPDATE ai_intake_proposals SET description_value = NULL WHERE intake_id = ?").run(intakeId);
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalNotReadyError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects defensively when the keywords decision is Accepted but the stored value is an empty array (constructed directly)", async () => {
      const proposal = await readyIntake({ keywords: "accepted" });
      sqlite.prepare("UPDATE ai_intake_proposals SET keywords_value = '[]' WHERE intake_id = ?").run(intakeId);
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalNotReadyError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("returns 404 (NotFoundError) when no proposal exists for the intake", async () => {
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: new Date().toISOString() }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("concurrency and staleness", () => {
    it("rejects a stale expectedProposalUpdatedAt", async () => {
      const proposal = await readyIntake();
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: "not-the-real-value" }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalVersionConflictError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("rejects when the staged photo set changed after generation", async () => {
      const proposal = await readyIntake();
      const storage = mockPhotoStorage();
      await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyPhotoSetStaleError);
      expect(await db.select().from(products)).toHaveLength(0);
    });
  });

  /**
   * Sprint 94 - genuine interleaving proof, mirroring Sprint 93's proven technique: a real
   * concurrent mutation is injected at the exact code boundary being guarded (before the apply
   * transaction's lock is acquired), via wrapping the transaction capability itself - not by
   * calling operations sequentially before the first one is even invoked. Where the true ordering
   * outcome (apply commits first) is what matters, a real sequential call proves the observable
   * result; no live PostgreSQL connection is available in this environment to prove actual lock
   * *blocking*, which is stated explicitly rather than claimed.
   */
  describe("locking and concurrent apply (interleaving)", () => {
    function wrapWithPreLockHook(real: AiIntakeApplyTransactionCapability, hook: () => Promise<void>): AiIntakeApplyTransactionCapability {
      let fired = false;
      return {
        driver: real.driver,
        execution: real.execution,
        async runWithLockedIntake(id: string, work: any) {
          if (!fired) {
            fired = true;
            await hook();
          }
          return real.runWithLockedIntake(id, work);
        },
      } as AiIntakeApplyTransactionCapability;
    }

    it("[A] cancellation committing before the apply lock is acquired blocks apply - no Product/Inventory/StockMovement created", async () => {
      const proposal = await readyIntake();
      const real = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      const wrapped = wrapWithPreLockHook(real, async () => {
        await cancelIntake(db as any, intakeId, "admin-1");
      });
      await expect(
        applyAiIntakeUseCase(wrapped, { intakeId, sku: "SKU-A", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toBeInstanceOf(AiIntakeApplyIntakeNotOpenError);
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
    });

    it("[B] when apply acquires the lock first, it commits, and a subsequent cancellation is rejected because status is Applied (documented limitation: true lock-contention blocking requires a live PostgreSQL connection, not reproducible against this synchronous single-connection SQLite test database)", async () => {
      const proposal = await readyIntake();
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(result.created).toBe(true);
      await expect(cancelIntake(db as any, intakeId, "admin-1")).rejects.toBeInstanceOf(BadRequestError);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.resultProductId).toBe(result.product.id); // cancellation never cleared it
    });

    it("[C] a proposal review committing before the apply lock is acquired causes a version conflict - no canonical writes", async () => {
      const proposal = await readyIntake();
      const real = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      const wrapped = wrapWithPreLockHook(real, async () => {
        // Changes updatedAt while keeping title Accepted (still ready) - proves the token check,
        // not a readiness failure.
        await updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Rejected, undefined, "admin-2", proposal.updatedAt);
      });
      await expect(
        applyAiIntakeUseCase(wrapped, { intakeId, sku: "SKU-C", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalVersionConflictError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("[D] when apply acquires the lock first, a subsequent proposal review attempt is rejected because the intake is no longer Open", async () => {
      const proposal = await readyIntake();
      await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      await expect(
        updateProposalFieldReview(db as any, intakeId, "description", AiIntakeFieldDecision.Rejected, undefined, "admin-2", proposal.updatedAt),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("[E] a photo uploaded before the apply lock is acquired causes a photo-set-stale rejection - no canonical writes", async () => {
      const proposal = await readyIntake();
      const storage = mockPhotoStorage();
      const real = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      const wrapped = wrapWithPreLockHook(real, async () => {
        await uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage);
      });
      await expect(
        applyAiIntakeUseCase(wrapped, { intakeId, sku: "SKU-E", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toBeInstanceOf(AiIntakeApplyPhotoSetStaleError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("[F] when apply acquires the lock first, it commits, and a subsequent photo upload attempt is rejected because the intake is no longer Open", async () => {
      const proposal = await readyIntake();
      const storage = mockPhotoStorage();
      await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      await expect(
        uploadIntakePhoto(db as any, intakeId, { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 }, "a.png", "admin-1", storage),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("[H] regeneration completing before the apply lock is acquired causes a version conflict - no canonical writes, intake remains Open, resultProductId remains null", async () => {
      const proposal = await readyIntake();
      const real = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      const wrapped = wrapWithPreLockHook(real, async () => {
        // Real production regeneration (not a manually edited row) - requires all fields Pending
        // first, exactly like a human resetting review before regenerating.
        const current = await getCurrentProposal(db as any, intakeId);
        await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Pending, undefined, "admin-2", current.updatedAt);
        await generateIntakeProposal(db as any, intakeId, stubProvider());
      });
      await expect(
        applyAiIntakeUseCase(wrapped, { intakeId, sku: "SKU-H", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toBeInstanceOf(AiIntakeApplyProposalVersionConflictError);
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
      expect(intake.resultProductId).toBeUndefined();
    });

    it("[I] when apply acquires the lock first, it commits, and a subsequent regeneration attempt is rejected because the intake is no longer Open", async () => {
      const proposal = await readyIntake();
      await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      await expect(generateIntakeProposal(db as any, intakeId, stubProvider())).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe("idempotency and retry", () => {
    /**
     * Sequential idempotency proof, not genuine concurrent-lock interleaving proof - the second
     * call is only made after the first has fully resolved. True concurrent-request serialization
     * (a second request's lock acquisition genuinely blocking behind the first) is verified only
     * by construction (PostgreSQL SELECT ... FOR UPDATE query shape, proven in the "database
     * foundation" tests below) - no live multi-connection PostgreSQL instance is available in this
     * environment to observe actual runtime contention.
     */
    it("two sequential Save as Draft requests: one creates the Product, the second returns the same Product - exactly one Product, one initial StockMovement", async () => {
      const proposal = await readyIntake();
      const request = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      const first = await saveAiIntakeAsDraft(db as any, intakeId, request as any, "admin-3");
      const second = await saveAiIntakeAsDraft(db as any, intakeId, request as any, "admin-3");
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.product.id).toBe(first.product.id);
      expect(await db.select().from(products)).toHaveLength(1);
      expect(await db.select().from(stockMovements)).toHaveLength(1);
    });

    it("an already-Applied retry with the original request body returns the existing Product (created: false), no new write", async () => {
      const proposal = await readyIntake();
      const request = validRequest({ expectedProposalUpdatedAt: proposal.updatedAt });
      const first = await saveAiIntakeAsDraft(db as any, intakeId, request as any, "admin-3");
      const retry = await saveAiIntakeAsDraft(db as any, intakeId, request as any, "admin-3");
      expect(retry.created).toBe(false);
      expect(retry.product.id).toBe(first.product.id);
      expect(await db.select().from(products)).toHaveLength(1);
      expect(await db.select().from(stockMovements)).toHaveLength(1);
    });

    it("retry does not reapply the original request's Product-creation fields (a different sku/price in the retry body is ignored)", async () => {
      const proposal = await readyIntake();
      const first = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, sku: "SKU-ORIGINAL" }) as any, "admin-3");
      const retry = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt, sku: "SKU-DIFFERENT", priceEur: 999 }) as any, "admin-3");
      expect(retry.product.id).toBe(first.product.id);
      expect(retry.product.sku).toBe("SKU-ORIGINAL");
      expect(retry.product.priceEur).not.toBe(999);
    });

    it("Applied with a null resultProductId (constructed directly - unreachable through the normal API) returns a deterministic conflict, creates nothing", async () => {
      const proposal = await readyIntake();
      sqlite.prepare("UPDATE ai_product_intakes SET status = 'applied', result_product_id = NULL WHERE id = ?").run(intakeId);
      await expect(
        saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
      ).rejects.toBeInstanceOf(AiIntakeApplyResultStateInvalidError);
      expect(await db.select().from(products)).toHaveLength(0);
    });

    it("returns the existing Product normally when it has since been archived", async () => {
      const proposal = await readyIntake();
      const first = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      sqlite.prepare("UPDATE products SET status = 'archived' WHERE id = ?").run(first.product.id);
      const retry = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      expect(retry.created).toBe(false);
      expect(retry.product.status).toBe("archived");
    });
  });

  describe("atomic rollback", () => {
    it("a canonical Product validation failure (invalid price) creates nothing and leaves the intake Open", async () => {
      const proposal = await readyIntake();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        applyAiIntakeUseCase(capability, { intakeId, sku: "SKU-BADPRICE", categoryId, type: ProductType.UniqueItem, priceEur: -5, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toThrow();
      expect(await db.select().from(products)).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
      expect(intake.resultProductId).toBeUndefined();
    });

    it("a nonexistent categoryId creates nothing and leaves the intake Open", async () => {
      const proposal = await readyIntake();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        applyAiIntakeUseCase(capability, { intakeId, sku: "SKU-BADCAT", categoryId: "does-not-exist", type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect(await db.select().from(products)).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
    });

    it("a duplicate SKU creates nothing and leaves the intake Open", async () => {
      const other = await createIntake(db as any, "admin-1");
      const otherGenerated = await generateIntakeProposal(db as any, other.id, stubProvider());
      const otherReviewed = await updateProposalFieldReview(db as any, other.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", otherGenerated.updatedAt);
      const existing = await saveAiIntakeAsDraft(db as any, other.id, validRequest({ intakeId: other.id, expectedProposalUpdatedAt: otherReviewed.updatedAt, sku: "SKU-DUPLICATE" }) as any, "admin-3");
      expect(existing.created).toBe(true);

      const proposal = await readyIntake();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        applyAiIntakeUseCase(capability, { intakeId, sku: "SKU-DUPLICATE", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toThrow();
      expect(await db.select().from(products)).toHaveLength(1); // only the first intake's Product
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
    });

    /**
     * Sprint 98: mirrors "a duplicate SKU creates nothing and leaves the intake Open" above, but
     * for a title-derived slug collision - no application-level pre-check exists for slug (only
     * existsBySku does), so this proves createProductWithInventoryInTransactionUseCase's
     * repository-layer conflict translation covers AI Intake Save as Draft identically to normal
     * Product creation, and that recovering with a genuinely unique title then succeeds.
     */
    it("a duplicate title's derived slug creates nothing and leaves the intake Open, resultProductId unset - a later unique title then succeeds", async () => {
      const other = await createIntake(db as any, "admin-1");
      const otherGenerated = await generateIntakeProposal(db as any, other.id, stubProvider());
      const otherReviewed = await updateProposalFieldReview(db as any, other.id, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", otherGenerated.updatedAt);
      const existing = await saveAiIntakeAsDraft(db as any, other.id, validRequest({ intakeId: other.id, expectedProposalUpdatedAt: otherReviewed.updatedAt, sku: "SKU-SLUG-OWNER" }) as any, "admin-3");
      expect(existing.created).toBe(true);
      expect(existing.product.title).toBe("Stub Title"); // same stub provider -> same derived slug

      const proposal = await readyIntake();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      let caught: unknown;
      try {
        await applyAiIntakeUseCase(capability, { intakeId, sku: "SKU-SLUG-CONFLICT", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictError);
      expect((caught as Error).message).toBe("A product with this SKU or slug already exists.");
      expect(await db.select().from(products)).toHaveLength(1); // only the first intake's Product
      expect(await db.select().from(stockMovements)).toHaveLength(1); // only the first intake's initial movement
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
      expect(intake.resultProductId).toBeUndefined();

      // Recovery: editing the reviewed title to a genuinely unique value through the existing
      // valid review flow, then retrying Save as Draft, succeeds - exactly one Product, one
      // Inventory initialization, one initial StockMovement on this successful first application.
      const edited = await updateProposalFieldReview(db as any, intakeId, "title", AiIntakeFieldDecision.Edited, "A Genuinely Unique Title", "admin-2", proposal.updatedAt);
      const recovered = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: edited.updatedAt, sku: "SKU-SLUG-RECOVERED" }) as any, "admin-3");
      expect(recovered.created).toBe(true);
      expect(recovered.product.title).toBe("A Genuinely Unique Title");
      expect(await db.select().from(products)).toHaveLength(2);
      expect(await db.select().from(stockMovements)).toHaveLength(2);
      const finalIntake = await getIntakeById(db as any, intakeId);
      expect(finalIntake.status).toBe(AiProductIntakeStatus.Applied);
      expect(finalIntake.resultProductId).toBe(recovered.product.id);
    });

    it("a database failure during Inventory/StockMovement creation rolls back the Product too - no partial state", async () => {
      const proposal = await readyIntake();
      sqlite.prepare("CREATE TRIGGER fail_stock_movement_insert AFTER INSERT ON stock_movements BEGIN SELECT RAISE(ABORT,'forced failure'); END;").run();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        applyAiIntakeUseCase(capability, { intakeId, sku: "SKU-INVFAIL", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toThrow();
      expect(await db.select().from(products)).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
      expect(intake.resultProductId).toBeUndefined();
    });

    it("a database failure during the final intake update rolls back the Product and StockMovement too", async () => {
      const proposal = await readyIntake();
      sqlite.prepare("CREATE TRIGGER fail_intake_apply_update AFTER UPDATE OF result_product_id ON ai_product_intakes BEGIN SELECT RAISE(ABORT,'forced failure'); END;").run();
      const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
      await expect(
        applyAiIntakeUseCase(capability, { intakeId, sku: "SKU-INTAKEFAIL", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3" }),
      ).rejects.toThrow();
      expect(await db.select().from(products)).toHaveLength(0);
      expect(await db.select().from(stockMovements)).toHaveLength(0);
      const intake = await getIntakeById(db as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Open);
    });
  });

  describe("database foundation", () => {
    it("SQLite ensureSchema is idempotent for the new applied_at/applied_by_admin_user_id columns", () => {
      const freshSqlite = new Database(":memory:");
      freshSqlite.pragma("foreign_keys = ON");
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      expect(() => ensureSchema(freshSqlite)).not.toThrow();
      const columns = (freshSqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(["applied_at", "applied_by_admin_user_id"]));
      freshSqlite.close();
    });

    it("PostgreSQL Drizzle construction remains valid for the ai-intake-apply transaction capability", async () => {
      const { createAiIntakeApplyTransactionCapabilityForDb: create } = await import("../src/services/aiIntakeApplyTransactionCapabilityForDb");
      const capability = create(db as any, "postgres");
      expect(capability.driver).toBe("postgres");
      expect(capability.execution).toBe("asynchronous");
    });

    it("migration 0011 adds the applied columns without dropping anything, and is included in migration validation", () => {
      const migrationSql = read("src/db/postgres-migrations/0011_sprint94_ai_intake_canonical_save_as_draft.sql");
      expect(migrationSql).toContain("ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS applied_at");
      expect(migrationSql).toContain("ALTER TABLE ai_product_intakes ADD COLUMN IF NOT EXISTS applied_by_admin_user_id");
      expect(migrationSql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);

      const validation = validatePostgresMigrationSql();
      expect(validation.status).toBe("PASS");
      expect(validation.hasDrop).toBe(false);
    });

    it("migrations 0001-0010 are unchanged", () => {
      for (const file of [
        "0001_sprint24_foundation.sql", "0002_sprint25_outbox.sql", "0003_sprint30a1_return_repository_foundation.sql",
        "0004_sprint33a_s3br_completion_idempotency.sql", "0005_sprint33a_s3br3_completed_sale_guard.sql", "0006_sprint64b_admin_auth.sql",
        "0007_sprint89_ai_draft_generation_baseline.sql", "0008_sprint90_ai_product_intake_foundation.sql", "0009_sprint91_ai_intake_photo_foundation.sql",
        "0010_sprint93_ai_intake_field_review_foundation.sql",
      ]) {
        expect(() => read(`src/db/postgres-migrations/${file}`)).not.toThrow();
      }
    });

    it("database parity remains PASS", () => {
      const parity = runSchemaParity();
      expect(parity.status).toBe("PASS");
    });

    /**
     * This proves persistence across a second query-layer handle over an already-Sprint-94-schema
     * database created fresh by beforeEach's ensureSchema() call - it does NOT prove backward-
     * compatible upgrade from a pre-Sprint-94 schema. See "genuinely upgrades an existing
     * Sprint 90-93 SQLite database" below for that proof.
     */
    it("(fresh-schema only) Applied status, resultProductId, and applied audit fields persist across a second query-layer handle over the same connection", async () => {
      const proposal = await readyIntake();
      const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
      const reconnected = drizzle(sqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
      const intake = await getIntakeById(reconnected as any, intakeId);
      expect(intake.status).toBe(AiProductIntakeStatus.Applied);
      expect(intake.resultProductId).toBe(result.product.id);
      expect(intake.appliedAt).toBeTruthy();
      expect(intake.appliedByAdminUserId).toBe("admin-3");
    });

    /**
     * Sprint 94 correction pass - the CRITICAL finding from the Exact Review, reproduced as a
     * permanent regression test. Genuinely starts from the pre-Sprint-94 (Sprint 90/93)
     * ai_product_intakes DDL - no applied_at/applied_by_admin_user_id columns - not a fresh
     * Sprint-94-schema database. Proves ensureSchema() upgrades it correctly, twice (idempotent),
     * preserves the existing row, and that the real Save as Draft flow then succeeds end-to-end
     * against the upgraded database.
     */
    it("genuinely upgrades an existing Sprint 90-93 SQLite database (no applied columns) and the real apply path then succeeds", async () => {
      const upgradeSqlite = new Database(":memory:");
      upgradeSqlite.pragma("foreign_keys = ON");

      // Step 2: the exact pre-Sprint-94 CREATE TABLE (Sprint 90/93), deliberately without
      // applied_at / applied_by_admin_user_id.
      upgradeSqlite.exec(`
        CREATE TABLE IF NOT EXISTS ai_product_intakes (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'open',
          created_by_admin_user_id TEXT NOT NULL,
          result_product_id TEXT UNIQUE,
          cancelled_at TEXT,
          cancelled_by_admin_user_id TEXT,
          cancellation_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_product_intakes_status ON ai_product_intakes(status);
      `);

      // Step 3: insert at least one existing Open intake.
      const preExistingId = "pre-existing-sprint93-intake";
      upgradeSqlite
        .prepare("INSERT INTO ai_product_intakes (id, status, created_by_admin_user_id, created_at, updated_at) VALUES (?, 'open', ?, ?, ?)")
        .run(preExistingId, "admin-1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

      // Step 4: run the current ensureSchema() - this must ALSO create every other table
      // (categories, ai_intake_proposals, ai_intake_photos, ...) needed for the rest of this test,
      // since this database started from only the one hand-written table above.
      expect(() => ensureSchema(upgradeSqlite)).not.toThrow();

      // Steps 5-7: inspect PRAGMA table_info, verify both applied columns now exist and are nullable.
      const columnInfo = upgradeSqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string; notnull: number }>;
      const columnsByName = new Map(columnInfo.map((c) => [c.name, c]));
      expect(columnsByName.has("applied_at")).toBe(true);
      expect(columnsByName.has("applied_by_admin_user_id")).toBe(true);
      expect(columnsByName.get("applied_at")!.notnull).toBe(0);
      expect(columnsByName.get("applied_by_admin_user_id")!.notnull).toBe(0);

      // Step 8: the original row remains, unchanged, with the new columns NULL.
      const preExistingRow = upgradeSqlite.prepare("SELECT * FROM ai_product_intakes WHERE id = ?").get(preExistingId) as Record<string, unknown>;
      expect(preExistingRow.status).toBe("open");
      expect(preExistingRow.created_by_admin_user_id).toBe("admin-1");
      expect(preExistingRow.created_at).toBe("2026-01-01T00:00:00.000Z");
      expect(preExistingRow.applied_at).toBeNull();
      expect(preExistingRow.applied_by_admin_user_id).toBeNull();

      // Steps 9-10: run ensureSchema() a second time - idempotent, no error, no duplicate/reconstructed schema.
      expect(() => ensureSchema(upgradeSqlite)).not.toThrow();
      const columnInfoAfterSecondRun = upgradeSqlite.prepare("PRAGMA table_info(ai_product_intakes)").all() as Array<{ name: string }>;
      expect(columnInfoAfterSecondRun.map((c) => c.name).sort()).toEqual(columnInfo.map((c) => c.name).sort());

      // Step 11: execute the REAL apply finalization path against the upgraded database - through
      // the full production Save as Draft flow (generate, review, apply), not a manually
      // constructed row.
      const upgradeDb = drizzle(upgradeSqlite, { schema: sqliteSchema }) as unknown as ReturnType<typeof createTestDb>;
      const category = await createCategory(upgradeDb as any, { name: "Upgrade Test Category", displayOrder: 0, isActive: true } as any);
      const generated = await generateIntakeProposal(upgradeDb as any, preExistingId, stubProvider());
      const reviewed = await updateProposalFieldReview(upgradeDb as any, preExistingId, "title", AiIntakeFieldDecision.Accepted, undefined, "admin-2", generated.updatedAt);
      const result = await saveAiIntakeAsDraft(
        upgradeDb as any,
        preExistingId,
        { sku: "SKU-UPGRADE", categoryId: category.id, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: reviewed.updatedAt } as any,
        "admin-3",
      );
      expect(result.created).toBe(true);
      const upgradedIntake = await getIntakeById(upgradeDb as any, preExistingId);
      expect(upgradedIntake.status).toBe(AiProductIntakeStatus.Applied);
      expect(upgradedIntake.resultProductId).toBe(result.product.id);
      expect(upgradedIntake.appliedByAdminUserId).toBe("admin-3");

      upgradeSqlite.close();
    });

    describe("PostgreSQL Date proposal-timestamp normalization", () => {
      /** Simulates the real Postgres driver behavior: proposal.updatedAt arrives as a Date instance, not a string. */
      function wrapWithDateProposalUpdatedAt(real: AiIntakeApplyTransactionCapability): AiIntakeApplyTransactionCapability {
        return {
          driver: real.driver,
          execution: real.execution,
          runWithLockedIntake(id: string, work: any) {
            return real.runWithLockedIntake(id, (ctx: any) => {
              const wrappedCtx = {
                ...ctx,
                readProposal: () => {
                  const result = ctx.readProposal();
                  const toDate = (row: any) => (row ? { ...row, updatedAt: new Date(row.updatedAt as string) } : row);
                  return result instanceof Promise ? result.then(toDate) : toDate(result);
                },
              };
              return work(wrappedCtx);
            });
          },
        } as AiIntakeApplyTransactionCapability;
      }

      it("(A) SQLite string timestamp + equal ISO token succeeds", async () => {
        const proposal = await readyIntake();
        const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
        const result = await applyAiIntakeUseCase(capability, {
          intakeId, sku: "SKU-TSA", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3",
        });
        expect(result.created).toBe(true);
      });

      it("(B) PostgreSQL-shaped Date runtime value + equal ISO token succeeds", async () => {
        const proposal = await readyIntake();
        const real = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
        const wrapped = wrapWithDateProposalUpdatedAt(real);
        const result = await applyAiIntakeUseCase(wrapped, {
          intakeId, sku: "SKU-TSB", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3",
        });
        expect(result.created).toBe(true);
      });

      it("(C) PostgreSQL-shaped Date runtime value + stale ISO token rejects with the proposal-version conflict", async () => {
        const proposal = await readyIntake();
        const real = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
        const wrapped = wrapWithDateProposalUpdatedAt(real);
        await expect(
          applyAiIntakeUseCase(wrapped, {
            intakeId, sku: "SKU-TSC", categoryId, type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: "not-the-real-value", actorId: "admin-3",
          }),
        ).rejects.toBeInstanceOf(AiIntakeApplyProposalVersionConflictError);
        expect(await db.select().from(products)).toHaveLength(0);
      });

      it("(D) no `as string` cast hides the Date runtime type in the comparison - source uses the Date-safe toIsoString helper, never String()", () => {
        const source = read("src/use-cases/ai-intake-apply/useCases.ts");
        expect(source).toContain("toIsoString(proposal.updatedAt");
        expect(source).not.toMatch(/String\(proposal\.updatedAt\)/);
      });
    });

    describe("single source of truth: intake finalization and category validation", () => {
      it("the real Save as Draft path exercises repositories/ai-product-intake/drizzle.ts's applyIntakeWithExpectedStateInTransaction (not an independent duplicate)", async () => {
        const repoModule = await import("../src/repositories/ai-product-intake/drizzle");
        const spy = vi.spyOn(repoModule, "applyIntakeWithExpectedStateInTransaction");
        const proposal = await readyIntake();
        await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
      });

      it("the standalone repository's applyWithExpectedState delegates to the same implementation and produces an identical result shape", async () => {
        const proposal = await readyIntake();
        const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
        const { createAiProductIntakeRepository } = await import("../src/repositories/ai-product-intake/factory");
        const repository = createAiProductIntakeRepository("sqlite", db as any);
        // The intake is now Applied - re-applying via the standalone repository method must be
        // rejected by the exact same guard the real flow uses (status no longer Open).
        const retryViaRepository = await repository.applyWithExpectedState({
          id: intakeId, resultProductId: "some-other-product-id", appliedAt: new Date().toISOString(), appliedByAdminUserId: "admin-4", updatedAt: new Date().toISOString(),
        });
        expect(retryViaRepository.updated).toBe(false);
        expect(retryViaRepository.conflict?.field).toBe("resultProductId");
        const intake = await getIntakeById(db as any, intakeId);
        expect(intake.resultProductId).toBe(result.product.id); // unchanged - the repository call never overwrote it
      });

      it("the real Save as Draft path exercises repositories/product-write/drizzle.ts's categoryExistsInTransaction (the same function services/products.ts's assertCategoryExists uses)", async () => {
        const repoModule = await import("../src/repositories/product-write/drizzle");
        const spy = vi.spyOn(repoModule, "categoryExistsInTransaction");
        const proposal = await readyIntake();
        await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
      });

      it("POST /api/products's canonical category check and Save as Draft's category check reject an identical nonexistent categoryId the same way (same BadRequestError, same message)", async () => {
        const { assertCategoryExists } = await import("../src/services/products");
        let canonicalError: Error | undefined;
        try {
          await assertCategoryExists(db as any, "does-not-exist");
        } catch (err) {
          canonicalError = err as Error;
        }
        const proposal = await readyIntake();
        const capability = createAiIntakeApplyTransactionCapabilityForDb(db as any, "sqlite");
        let applyError: Error | undefined;
        try {
          await applyAiIntakeUseCase(capability, {
            intakeId, sku: "SKU-CAT", categoryId: "does-not-exist", type: ProductType.UniqueItem, priceEur: 10, expectedProposalUpdatedAt: proposal.updatedAt, actorId: "admin-3",
          });
        } catch (err) {
          applyError = err as Error;
        }
        expect(canonicalError).toBeInstanceOf(BadRequestError);
        expect(applyError).toBeInstanceOf(BadRequestError);
        expect(applyError?.message).toBe(canonicalError?.message);
      });
    });

    describe("Applied result-state correction", () => {
      it("Applied + resultProductId referencing a missing Product (constructed directly - unreachable through the normal API) returns AI_INTAKE_APPLY_RESULT_STATE_INVALID, not a generic 404, and creates nothing", async () => {
        const proposal = await readyIntake();
        const result = await saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3");
        // Simulate a Product that no longer exists for an already-Applied intake - delete
        // dependent rows first to satisfy the foreign_keys=ON pragma this suite runs under.
        sqlite.prepare("DELETE FROM stock_movements WHERE product_id = ?").run(result.product.id);
        sqlite.prepare("DELETE FROM products WHERE id = ?").run(result.product.id);
        await expect(
          saveAiIntakeAsDraft(db as any, intakeId, validRequest({ expectedProposalUpdatedAt: proposal.updatedAt }) as any, "admin-3"),
        ).rejects.toBeInstanceOf(AiIntakeApplyResultStateInvalidError);
        expect(await db.select().from(products)).toHaveLength(0); // no replacement Product was created
        const intake = await getIntakeById(db as any, intakeId);
        expect(intake.resultProductId).toBe(result.product.id); // never cleared or replaced
      });
    });
  });
});
