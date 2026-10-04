import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { createSocialDraftUseCase, createGeneratedSocialDraftUseCase, validateEditorialAltTextSelection, validateSocialSelection, type GeneratedSocialDraftInput } from "../use-cases/social-content/useCases";
import { and, asc, desc, eq } from "drizzle-orm";
import type { SocialContent, SocialContentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { socialApprovalSchema, socialEditSchema, socialId, socialListSchema, socialTransitionSchema, type SocialDraft } from "../validation/socialContent";
import { createSocialContentApprovalRepository, type SocialContentApproval } from "../repositories/social-content/approvals";
import { createPreparedImageRepository } from "../repositories/social-content/preparedImages";
import { createSocialContentPreparationService } from "./socialContentPreparation";

const transitions: Record<SocialContentStatus, SocialContentStatus[]> = {
  draft: ["ready_for_review"], ready_for_review: ["approved", "rejected"], rejected: ["draft"], approved: [],
};


/** Editorial transactions only. No provider, credentials, jobs, or publishing dependencies. */
export function createSocialContentService(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite") {
  const sync = driver === "sqlite" || driver === "test-memory";
  const schema = sync ? sqlite : postgres;
  const { socialContents: contents, socialContentMedia: media } = schema;
  const now = () => sync ? new Date().toISOString() : new Date();

  const repository = createSocialContentRepository(db, driver);
  const { transaction, detail, replaceMedia } = repository;
  function* selection(tx: any, input: Pick<SocialDraft, "productId" | "mediaIds">) {
    yield* validateSocialSelection(repository, tx, input);
  }

  function* locked(tx: any, id: string, version: number): Generator<any, any, any> {
    let query = tx.select().from(contents).where(eq(contents.id, id));
    if (!sync) query = query.for("update");
    const [row] = yield query;
    if (!row) throw new NotFoundError("Social content not found");
    if (row.version !== version) throw new ConflictError("Content changed. Reload before continuing.");
    return row;
  }

  function* transitionInTransaction(tx: any, id: string, input: { status: SocialContentStatus; expectedVersion: number }): Generator<any, SocialContent, any> {
    const current = yield* locked(tx, id, input.expectedVersion);
    if (!transitions[current.status as SocialContentStatus]?.includes(input.status)) throw new ConflictError("Invalid social content transition");
    if (input.status === "ready_for_review" || input.status === "approved") {
      const selected = yield tx.select({ photoId: media.photoId }).from(media).where(eq(media.contentId, id));
      if (!selected.length || !current.caption.trim()) throw new BadRequestError("A caption and at least one photo are required for review");
      if (selected.some((item: any) => !item.photoId)) throw new BadRequestError("Selected media is no longer available. Return to draft and select media again.");
      yield* selection(tx, { productId: current.productId, mediaIds: selected.map((item: any) => item.photoId) });
    }
    const [row] = yield tx.update(contents).set({ status: input.status, version: current.version + 1, updatedAt: now() })
      .where(and(eq(contents.id, id), eq(contents.version, current.version), eq(contents.status, current.status))).returning();
    if (!row) throw new ConflictError("Content changed. Reload before continuing.");
    return yield* detail(tx, row);
  }

  return {
    async list(query: unknown) {
      const input = socialListSchema.parse(query);
      return transaction(function* (tx) {
        const rows = yield tx.select().from(contents).where(and(
          input.status ? eq(contents.status, input.status) : undefined,
          input.contentType ? eq(contents.contentType, input.contentType) : undefined,
        )).orderBy(desc(contents.updatedAt), asc(contents.id)).limit(input.pageSize + 1).offset((input.page - 1) * input.pageSize);
        const items: SocialContent[] = [];
        for (const row of rows.slice(0, input.pageSize)) items.push(yield* detail(tx, row));
        return { items, page: input.page, hasMore: rows.length > input.pageSize };
      });
    },
    async get(id: string) {
      socialId.parse(id);
      return transaction(function* (tx) {
        return yield* detail(tx, (yield tx.select().from(contents).where(eq(contents.id, id)))[0]);
      });
    },
    create: (value: unknown) => createSocialDraftUseCase(repository, value),
    // Internal persistence boundary; provider generation has its own orchestration service.
    createGenerated: (value: GeneratedSocialDraftInput) => createGeneratedSocialDraftUseCase(repository, value),
    async edit(id: string, value: unknown) {
      socialId.parse(id);
      const input = socialEditSchema.parse(value);
      validateEditorialAltTextSelection(input);
      return transaction(function* (tx) {
        const current = yield* locked(tx, id, input.expectedVersion);
        if (current.status !== "draft") throw new ConflictError("Only draft content can be edited");
        yield* selection(tx, input);
        const [row] = yield tx.update(contents).set({ contentType: input.contentType, caption: input.caption, productId: input.productId,
          hashtags: input.hashtags === undefined ? current.hashtags : JSON.stringify(input.hashtags),
          concept: input.concept === undefined ? current.concept : input.concept,
          updatedAt: now(), version: current.version + 1 }).where(and(eq(contents.id, id), eq(contents.version, current.version), eq(contents.status, "draft"))).returning();
        if (!row) throw new ConflictError("Content changed. Reload before continuing.");
        yield* replaceMedia(tx, id, input.mediaIds, input.mediaEditorialAltTexts);
        return yield* detail(tx, row);
      });
    },
    async transition(id: string, value: unknown) {
      socialId.parse(id);
      const input = socialTransitionSchema.parse(value);
      if (input.status === "approved") throw new BadRequestError("Explicit prepared-image Human Approval is required");
      return transaction(function* (tx) {
        return yield* transitionInTransaction(tx, id, input);
      });
    },
    async approve(id: string, value: unknown, actorId: string): Promise<SocialContentApproval> {
      socialId.parse(id);
      socialId.parse(actorId);
      const input = socialApprovalSchema.parse(value);
      const approvals = createSocialContentApprovalRepository(db, driver);
      const prepared = createPreparedImageRepository(db, driver);
      const replay = (row: SocialContentApproval) => {
        if (row.contentId !== id || row.preparedImageId !== input.preparedImageId ||
            row.contentVersion !== input.expectedVersion || row.approvedByAdminUserId !== actorId) {
          throw new ConflictError("Approval request identity does not match");
        }
        return row; // Historical evidence only, not a claim of continuing media validity.
      };
      const lookup = () => transaction(function* (tx) { return yield* approvals.findByRequestId(tx, input.requestId); });
      const existing = await lookup();
      if (existing) return replay(existing);
      function* snapshot(tx: any) {
        // Lock content before media/artifact rows, matching the editorial mutation order.
        yield* locked(tx, id, input.expectedVersion);
        const image = yield* prepared.find(tx, id, input.preparedImageId);
        const source = yield* prepared.source(tx, id, image.sourcePhotoId);
        return { image, source };
      }
      try {
        const before = await transaction(snapshot);
        await createSocialContentPreparationService(db, driver).validatePreparedImageCurrent(id, input.preparedImageId);
        return await transaction(function* (tx) {
          yield* locked(tx, id, input.expectedVersion);
          const completed = yield* approvals.findByRequestId(tx, input.requestId);
          if (completed) return replay(completed);
          const current = yield* snapshot(tx);
          if (JSON.stringify(before) !== JSON.stringify(current)) throw new ConflictError("Prepared image state changed before approval");
          const approval = yield* approvals.insert(tx, {
            requestId: input.requestId, contentId: id, preparedImageId: input.preparedImageId,
            contentVersion: input.expectedVersion, approvedByAdminUserId: actorId,
          });
          yield* transitionInTransaction(tx, id, { status: "approved", expectedVersion: input.expectedVersion });
          return approval;
        });
      } catch (error) {
        // A concurrent winner is read only after the failed transaction has rolled back.
        if (error instanceof ConflictError || approvals.isRequestConflict(error)) {
          const completed = await lookup();
          if (completed) return replay(completed);
        }
        throw error;
      }
    },
  };
}
