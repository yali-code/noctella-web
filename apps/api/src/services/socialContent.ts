import { createSocialContentRepository } from "../repositories/social-content/drizzle";
import { createSocialDraftUseCase, createGeneratedSocialDraftUseCase, validateEditorialAltTextSelection, validateSocialSelection, type GeneratedSocialDraftInput } from "../use-cases/social-content/useCases";
import { and, asc, desc, eq } from "drizzle-orm";
import type { SocialContent, SocialContentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { socialEditSchema, socialId, socialListSchema, socialTransitionSchema, type SocialDraft } from "../validation/socialContent";

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
    // Internal checkpoint boundary only; no generation HTTP route or provider transport.
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
      return transaction(function* (tx) {
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
      });
    },
  };
}
