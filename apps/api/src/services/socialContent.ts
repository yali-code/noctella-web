import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { SocialContent, SocialContentStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import * as sqlite from "../db/schema.sqlite";
import * as postgres from "../db/schema.postgres";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { socialDraftSchema, socialEditSchema, socialId, socialListSchema, socialTransitionSchema, type SocialDraft } from "../validation/socialContent";

const transitions: Record<SocialContentStatus, SocialContentStatus[]> = {
  draft: ["ready_for_review"], ready_for_review: ["approved", "rejected"], rejected: ["draft"], approved: [],
};
const iso = (date: string | Date) => date instanceof Date ? date.toISOString() : date;

/** Editorial transactions only. No provider, credentials, jobs, or publishing dependencies. */
export function createSocialContentService(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite") {
  const sync = driver === "sqlite" || driver === "test-memory";
  const schema = sync ? sqlite : postgres;
  const { socialContents: contents, socialContentMedia: media, products, productPhotos: photos } = schema;
  const now = () => sync ? new Date().toISOString() : new Date();

  // A single domain transaction program runs synchronously for SQLite and awaits
  // each query for PostgreSQL. Never pass an async callback to better-sqlite3.
  async function transaction<T>(work: (tx: any) => Generator<any, T, any>): Promise<T> {
    if (sync) return (db as any).transaction((tx: any) => {
      const program = work(tx);
      let step = program.next();
      while (!step.done) step = program.next(step.value.all());
      return step.value;
    });
    return (db as any).transaction(async (tx: any) => {
      const program = work(tx);
      let step = program.next();
      while (!step.done) step = program.next(await step.value);
      return step.value;
    });
  }

  function* selection(tx: any, input: Pick<SocialDraft, "productId" | "mediaIds">): Generator<any, void, any> {
    if (input.productId) {
      let query = tx.select({ id: products.id }).from(products).where(eq(products.id, input.productId));
      if (!sync) query = query.for("share");
      if (!(yield query).length) throw new BadRequestError("Selected product does not exist");
    }
    if (input.mediaIds.length) {
      let query = tx.select().from(photos).where(inArray(photos.id, input.mediaIds));
      if (!sync) query = query.for("share");
      const rows = yield query;
      if (rows.length !== input.mediaIds.length) throw new BadRequestError("Selected media does not exist");
      if (rows.some((photo: any) => (input.productId && photo.productId !== input.productId) || photo.processingStatus !== "Ready")) {
        throw new BadRequestError("Selected media must be ready and belong to the selected product");
      }
    }
  }

  function* detail(tx: any, row: any): Generator<any, SocialContent, any> {
    if (!row) throw new NotFoundError("Social content not found");
    const product = row.productId ? (yield tx.select({ id: products.id, title: products.title, sku: products.sku }).from(products).where(eq(products.id, row.productId)))[0] ?? null : null;
    const selected = yield tx.select({ id: photos.id, productId: photos.productId, url: photos.url, thumbnailUrl: photos.thumbnailUrl, altText: photos.altText })
      .from(media).innerJoin(photos, eq(photos.id, media.photoId)).where(eq(media.contentId, row.id)).orderBy(asc(media.sortOrder));
    const references = yield tx.select({ photoId: media.photoId }).from(media).where(eq(media.contentId, row.id));
    return { id: row.id, platform: row.platform, accountLabel: row.accountLabel, contentType: row.contentType,
      status: row.status, caption: row.caption, productId: row.productId, product, media: selected, missingMediaCount: references.length - selected.length,
      version: row.version, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  }

  function* replaceMedia(tx: any, id: string, ids: string[]): Generator<any, void, any> {
    yield tx.delete(media).where(eq(media.contentId, id)).returning();
    if (ids.length) yield tx.insert(media).values(ids.map((photoId, sortOrder) => ({ id: randomUUID(), contentId: id, photoId, sortOrder }))).returning();
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
    async create(value: unknown) {
      const input = socialDraftSchema.parse(value);
      return transaction(function* (tx) {
        yield* selection(tx, input);
        const id = randomUUID(), timestamp = now();
        const [row] = yield tx.insert(contents).values({ id, platform: "instagram", accountLabel: "vault", contentType: input.contentType,
          caption: input.caption, productId: input.productId, status: "draft", version: 1, createdAt: timestamp, updatedAt: timestamp }).returning();
        yield* replaceMedia(tx, id, input.mediaIds);
        return yield* detail(tx, row);
      });
    },
    async edit(id: string, value: unknown) {
      socialId.parse(id);
      const input = socialEditSchema.parse(value);
      return transaction(function* (tx) {
        const current = yield* locked(tx, id, input.expectedVersion);
        if (current.status !== "draft") throw new ConflictError("Only draft content can be edited");
        yield* selection(tx, input);
        const [row] = yield tx.update(contents).set({ contentType: input.contentType, caption: input.caption, productId: input.productId,
          updatedAt: now(), version: current.version + 1 }).where(and(eq(contents.id, id), eq(contents.version, current.version), eq(contents.status, "draft"))).returning();
        if (!row) throw new ConflictError("Content changed. Reload before continuing.");
        yield* replaceMedia(tx, id, input.mediaIds);
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
