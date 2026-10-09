import { sql } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { createProductReadServiceContextForDb } from "../../repositories/product-read/factory";
import { listProductMarketingTags } from "../../services/marketingTags";
import { listExternalListings } from "../../services/marketplacePublishing";
import { readAdsReservationAwareAvailability } from "./adsInventoryRead";
import { readMarketplaceCampaignCandidatesForProduct } from "./marketplaceCampaignRead";
import type { FunnelListingFacts } from "./marketplaceFunnelLinks";

/**
 * Stock Sync persists provider externalListingId (eBay/Etsy listing number), NOT
 * the internal external_listings.id. Never join historical stock facts on row ID.
 */
export function stockSyncProviderListingIdentity(listing: {
  readonly channel: string;
  readonly externalListingId: string;
}): { readonly channel: string; readonly providerListingId: string } | null {
  if ((listing.channel !== "ebay" && listing.channel !== "etsy")
    || !/^[0-9]{5,20}$/.test(listing.externalListingId)) return null;
  return { channel: listing.channel, providerListingId: listing.externalListingId };
}

/** Local snapshots are historical evidence, not guaranteed real-time listing status. */
export interface AdsListingEvidence {
  readonly productId: string;
  readonly listingRowId: string;
  readonly externalUpdatedAt: string;
  readonly snapshotCapturedAt: string | null;
  readonly marketplaceStock: number | null;
  readonly openConflictCount: number;
}

export function isReviewableMarketplaceEvidence(
  evidence: AdsListingEvidence,
  now: Date,
  maxAgeMs = 24 * 60 * 60 * 1000,
): boolean {
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(evidence.openConflictCount)
    || evidence.openConflictCount !== 0 || !Number.isSafeInteger(evidence.marketplaceStock)
    || (evidence.marketplaceStock ?? 0) < 1) return false;
  const listingAt = Date.parse(evidence.externalUpdatedAt);
  const inventoryAt = Date.parse(evidence.snapshotCapturedAt ?? "");
  return [listingAt, inventoryAt].every(at => Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= maxAgeMs);
}

/**
 * ADS-002C.4 — Use existing ERP readers, no new tables, writes or API endpoints.
 * Local snapshot freshness is a strict REVIEW gate, never proof of live availability.
 * Before any paid ads, a provider-side recheck and approved account must be added.
 */
export async function readAdsCampaignReviewFromErp(
  db: DbClient,
  productId: string,
  now = new Date(),
) {
  const context = createProductReadServiceContextForDb(db);
  return readMarketplaceCampaignCandidatesForProduct(productId, {
    readProduct: async id => {
      const p = await context.repositories.products.getById(id);
      return p ? { id: p.id, title: p.title, status: p.status, salePausedAt: p.salePausedAt, category: p.categoryId } : null;
    },
    readAvailability: id => readAdsReservationAwareAvailability(db, id),
    readMarketingTags: async id => (await listProductMarketingTags(db, id)).map(tag => ({ key: tag.key })),
    readExternalListings: async id => {
      const external = await listExternalListings(db, id);
      const results: FunnelListingFacts[] = [];
      for (const listing of external) {
        if (listing.channel !== "ebay" && listing.channel !== "etsy") continue;
        // Only exact active is accepted by the existing funnel policy.
        if (listing.externalStatus.toLowerCase() !== "active") continue;
        const identity = stockSyncProviderListingIdentity(listing);
        if (!identity) continue;
        const snapshots = await db.all(sql`
          SELECT captured_at AS captured_at, marketplace_stock AS marketplace_stock
          FROM marketplace_inventory_snapshots
          WHERE product_id = ${id} AND channel = ${identity.channel}
            AND external_listing_id = ${identity.providerListingId}
          ORDER BY captured_at DESC LIMIT 1
        `) as Array<{ captured_at: string; marketplace_stock: number }>;
        const conflicts = await db.all(sql`
          SELECT COUNT(*) AS conflict_count FROM stock_sync_conflicts
          WHERE status = 'open' AND channel = ${listing.channel}
            AND (product_id = ${id} OR external_listing_id = ${identity.providerListingId})
        `) as Array<{ conflict_count: number }>;
        if (!isReviewableMarketplaceEvidence({
          productId: id, listingRowId: listing.id, externalUpdatedAt: listing.updatedAt,
          snapshotCapturedAt: snapshots[0]?.captured_at ?? null,
          marketplaceStock: snapshots[0]?.marketplace_stock ?? null,
          openConflictCount: Number(conflicts[0]?.conflict_count ?? NaN),
        }, now)) continue;
        results.push({
          channel: listing.channel, externalStatus: listing.externalStatus,
          externalListingId: listing.externalListingId, externalListingUrl: listing.externalListingUrl ?? null,
        });
      }
      return results;
    },
  });
}
