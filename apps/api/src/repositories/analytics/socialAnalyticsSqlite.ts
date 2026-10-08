import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";

/**
 * Analytics Stage 3: read-only social analytics queries (SELECT only). The Instagram
 * media -> product link is the existing publishing chain:
 * instagram_publish_attempts.approval_id -> social_content_approvals.content_id ->
 * social_contents.product_id. No duplicate mapping table.
 */
export function createSqliteSocialAnalyticsRepository(db: any) {
  return Object.freeze({
    /** Published Instagram media, newest first, published at/after `sinceIso`, bounded by `limit`. */
    listInstagramPublishedMedia(sinceIso: string, limit: number) {
      const a = schema.instagramPublishAttempts;
      return (db
        .select({ mediaId: a.publishedMediaId, attemptId: a.id, publishedAt: a.publishedAt, socialContentId: schema.socialContents.id, productId: schema.socialContents.productId, contentType: schema.socialContents.contentType })
        .from(a)
        .leftJoin(schema.socialContentApprovals, eq(schema.socialContentApprovals.id, a.approvalId))
        .leftJoin(schema.socialContents, eq(schema.socialContents.id, schema.socialContentApprovals.contentId))
        .where(and(eq(a.status, "published"), isNotNull(a.publishedMediaId), gte(a.publishedAt, sinceIso)))
        .orderBy(desc(a.publishedAt), asc(a.id))
        .limit(limit)
        .all() as any[]).map((r) => ({ mediaId: String(r.mediaId), attemptId: r.attemptId as string, publishedAt: (r.publishedAt ?? null) as string | null, socialContentId: (r.socialContentId ?? null) as string | null, productId: (r.productId ?? null) as string | null, contentType: (r.contentType ?? null) as string | null }));
    },

    countInstagramPublishedMedia(sinceIso: string): number {
      const a = schema.instagramPublishAttempts;
      return (db.select({ id: a.id }).from(a).where(and(eq(a.status, "published"), isNotNull(a.publishedMediaId), gte(a.publishedAt, sinceIso))).all() as any[]).length;
    },

    productIdsBySlug(slugs: readonly string[]): Map<string, string> {
      const unique = [...new Set(slugs)];
      if (unique.length === 0) return new Map();
      return new Map((db.select({ id: schema.products.id, slug: schema.products.slug }).from(schema.products).where(inArray(schema.products.slug, unique)).all() as any[]).map((r) => [r.slug, r.id]));
    },

    /** External social snapshot rows (bounded), oldest first. */
    listSocialSnapshots(platforms: readonly string[], limit = 50_000) {
      const t = schema.analyticsMetricSnapshots;
      return db.select().from(t).where(and(eq(t.sourceType, "external_platform"), inArray(t.metricNamespace, [...platforms]))).orderBy(asc(t.observedAt), asc(t.collectedAt)).limit(limit).all() as any[];
    },

    listScopeHistory(scopeId: string, query: { metricKey?: string; from?: string; to?: string; limit: number }) {
      const t = schema.analyticsMetricSnapshots;
      const filters = [eq(t.scopeId, scopeId), eq(t.sourceType, "external_platform")];
      if (query.metricKey) filters.push(eq(t.metricKey, query.metricKey));
      if (query.from) filters.push(gte(t.observedAt, query.from));
      if (query.to) filters.push(lte(t.observedAt, query.to));
      return db.select().from(t).where(and(...filters)).orderBy(asc(t.observedAt), asc(t.metricKey)).limit(query.limit).all() as any[];
    },
  });
}
