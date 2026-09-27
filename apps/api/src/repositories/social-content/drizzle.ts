import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { SocialContent } from "@noctella/shared";
import type { DbClient } from "../../db/client";
import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { NotFoundError } from "../../services/errors";
import type { SocialContentRepository, SocialDraftInsert, SocialWork } from "./types";
const iso = (date: string | Date) => date instanceof Date ? date.toISOString() : date;

export function createSocialContentRepository(db: DbClient, driver = process.env.DATABASE_DRIVER ?? "sqlite"): SocialContentRepository {
  const sync = driver === "sqlite" || driver === "test-memory";
  const { socialContents: contents, socialContentMedia: media, products, productPhotos: photos } = sync ? sqlite : postgres;
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


  function* detail(tx: any, row: any): Generator<any, SocialContent, any> {
    if (!row) throw new NotFoundError("Social content not found");
    const product = row.productId ? (yield tx.select({ id: products.id, title: products.title, sku: products.sku }).from(products).where(eq(products.id, row.productId)))[0] ?? null : null;
    const selected = yield tx.select({ id: photos.id, productId: photos.productId, url: photos.url, thumbnailUrl: photos.thumbnailUrl, altText: photos.altText, editorialAltText: media.editorialAltText })
      .from(media).innerJoin(photos, eq(photos.id, media.photoId)).where(eq(media.contentId, row.id)).orderBy(asc(media.sortOrder));
    const references = yield tx.select({ photoId: media.photoId }).from(media).where(eq(media.contentId, row.id));
    return { id: row.id, platform: row.platform, accountLabel: row.accountLabel, contentType: row.contentType,
      status: row.status, caption: row.caption, productId: row.productId, product, media: selected, missingMediaCount: references.length - selected.length,
      hashtags: row.hashtags == null ? null : JSON.parse(row.hashtags), concept: row.concept ?? null,
      aiProvider: row.aiProvider ?? null, aiModel: row.aiModel ?? null, aiPromptVersion: row.aiPromptVersion ?? null,
      aiGeneratedAt: row.aiGeneratedAt == null ? null : iso(row.aiGeneratedAt), aiRequestId: row.aiRequestId ?? null,
      aiSourceProductId: row.aiSourceProductId ?? null,
      version: row.version, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  }


  function* replaceMedia(tx: any, id: string, ids: string[], altTexts?: Array<{ photoId: string; editorialAltText: string }>): SocialWork<void> {
    const existing = yield tx.select({ photoId: media.photoId, editorialAltText: media.editorialAltText }).from(media).where(eq(media.contentId, id));
    const texts = new Map<string, string | null>(existing.filter((item: any) => item.photoId).map((item: any) => [item.photoId, item.editorialAltText]));
    for (const item of altTexts ?? []) texts.set(item.photoId, item.editorialAltText);
    yield tx.delete(media).where(eq(media.contentId, id)).returning();
    if (ids.length) yield tx.insert(media).values(ids.map((photoId, sortOrder) => ({ id: randomUUID(), contentId: id, photoId, sortOrder, editorialAltText: texts.get(photoId) ?? null }))).returning();
  }
  return {
    transaction, detail, replaceMedia,
    *readProduct(tx, id) {
      let query = tx.select({ id: products.id, updatedAt: products.updatedAt }).from(products).where(eq(products.id, id));
      if (!sync) query = query.for("share");
      return (yield query)[0];
    },
    *readPhotos(tx, ids) {
      let query = tx.select({ id: photos.id, productId: photos.productId, processingStatus: photos.processingStatus }).from(photos).where(inArray(photos.id, ids));
      if (!sync) query = query.for("share");
      return yield query;
    },
    *findByRequest(tx, requestId) {
      const [row] = yield tx.select().from(contents).where(eq(contents.aiRequestId, requestId));
      return row ? yield* detail(tx, row) : null;
    },
    *insertDraft(tx, input: SocialDraftInsert, ids, altTexts) {
      const { generation, hashtags, ...row } = input;
      const [created] = yield tx.insert(contents).values({ ...row, ...generation,
        hashtags: hashtags === null ? null : JSON.stringify(hashtags),
        createdAt: sync ? row.createdAt : new Date(row.createdAt),
        updatedAt: sync ? row.updatedAt : new Date(row.updatedAt),
        aiGeneratedAt: generation ? (sync ? generation.aiGeneratedAt : new Date(generation.aiGeneratedAt)) : null,
      }).returning();
      yield* replaceMedia(tx, created.id, ids, altTexts);
      return yield* detail(tx, created);
    },
    isRequestConflict(error) {
      let current = error;
      for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
        const item = current as { code?: string; constraint?: string; message?: string; cause?: unknown };
        if (item.code === "23505" && item.constraint === "idx_social_contents_ai_request_unique") return true;
        if (item.code === "SQLITE_CONSTRAINT_UNIQUE" && item.message?.includes("social_contents.ai_request_id")) return true;
        current = item.cause;
      }
      return false;
    },
  };
}
