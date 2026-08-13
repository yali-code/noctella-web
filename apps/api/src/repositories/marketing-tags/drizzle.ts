import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { marketingTags, productMarketingTags } from "../../db/schema";
import type { DbClient } from "../../db/client";
import type { MarketingTagRecord, MarketingTagRepository } from "./types";

/**
 * Sprint 140: plain, non-transaction-scoped Marketing Tag repository - mirrors
 * repositories/marketplace-preparation/drizzle.ts's createDrizzleMarketplacePreparationRepository
 * exactly (check-then-insert idempotency, the same established convention as
 * services/salesInvoiceOutbox.ts's enqueueSalesInvoiceDraftForPaidOrder). Both DbClient drivers
 * are uniformly awaitable outside an explicit db.transaction() callback, so no sync/async
 * execution-aware duality is needed here.
 */
export function createDrizzleMarketingTagRepository(db: DbClient): MarketingTagRepository {
  return {
    async findOrCreateByKey(key: string, label: string): Promise<MarketingTagRecord> {
      const [existing] = await db.select().from(marketingTags).where(eq(marketingTags.key, key)).limit(1);
      if (existing) return existing as MarketingTagRecord;

      const now = new Date().toISOString();
      const [inserted] = await db
        .insert(marketingTags)
        .values({ id: randomUUID(), key, label, createdAt: now, updatedAt: now })
        .returning();
      return inserted as MarketingTagRecord;
    },

    async listByProduct(productId: string): Promise<MarketingTagRecord[]> {
      const rows = await db
        .select({
          id: marketingTags.id,
          key: marketingTags.key,
          label: marketingTags.label,
          createdAt: marketingTags.createdAt,
          updatedAt: marketingTags.updatedAt,
        })
        .from(productMarketingTags)
        .innerJoin(marketingTags, eq(marketingTags.id, productMarketingTags.marketingTagId))
        .where(eq(productMarketingTags.productId, productId))
        .orderBy(asc(productMarketingTags.createdAt), asc(productMarketingTags.id));
      return rows as MarketingTagRecord[];
    },

    async hasAnyForProduct(productId: string): Promise<boolean> {
      const [row] = await db.select({ id: productMarketingTags.id }).from(productMarketingTags).where(eq(productMarketingTags.productId, productId)).limit(1);
      return !!row;
    },

    async addRelation(productId: string, marketingTagId: string): Promise<void> {
      const [existing] = await db
        .select({ id: productMarketingTags.id })
        .from(productMarketingTags)
        .where(and(eq(productMarketingTags.productId, productId), eq(productMarketingTags.marketingTagId, marketingTagId)))
        .limit(1);
      if (existing) return;

      await db.insert(productMarketingTags).values({ id: randomUUID(), productId, marketingTagId, createdAt: new Date().toISOString() });
    },

    async removeRelation(productId: string, marketingTagId: string): Promise<boolean> {
      const deleted = await db
        .delete(productMarketingTags)
        .where(and(eq(productMarketingTags.productId, productId), eq(productMarketingTags.marketingTagId, marketingTagId)))
        .returning();
      return deleted.length > 0;
    },
  };
}
