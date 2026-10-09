import {
  evaluateFunnelLink,
  type FunnelListingFacts,
  type FunnelProductFacts,
  type FunnelLinkBlocker,
  type FunnelMarketplace,
} from "./marketplaceFunnelLinks";

/**
 * ADS-002C.1: a read-only campaign prospecting projection, not a campaign API.
 * Inputs must be sourced by an eventual trusted ERP stock/listing read service.
 * Never accept client-submitted quantities or inferred marketplace availability.
 */
export interface CampaignProductFacts {
  readonly productId: string;
  readonly title: string;
  readonly category: string | null;
  readonly marketingTagKeys: readonly string[];
  readonly product: FunnelProductFacts;
  readonly listings: readonly FunnelListingFacts[];
}
export interface CampaignCandidate {
  readonly productId: string;
  readonly title: string;
  readonly category: string | null;
  readonly tagKeys: readonly string[];
  readonly destination: FunnelMarketplace;
  readonly marketplaceUrl: string;
  /** This does not authorize spending or assert live provider availability. */
  readonly decision: "ELIGIBLE_FOR_REVIEW";
}
export interface CampaignExclusion {
  readonly productId: string;
  readonly channel: string;
  readonly blocker: FunnelLinkBlocker | "NO_LISTING" | "INVALID_PRODUCT_ID";
}
export interface CampaignCandidateProjection {
  readonly candidates: readonly CampaignCandidate[];
  readonly exclusions: readonly CampaignExclusion[];
  readonly requiresOwnerApproval: true;
  readonly spendAuthorized: false;
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.filter((tag) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)))].sort();
}

export function projectMarketplaceCampaignCandidates(
  records: readonly CampaignProductFacts[],
): CampaignCandidateProjection {
  const candidates: CampaignCandidate[] = [];
  const exclusions: CampaignExclusion[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (!record.productId || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.productId)) {
      exclusions.push({ productId: record.productId, channel: "", blocker: "INVALID_PRODUCT_ID" });
      continue;
    }
    if (record.listings.length === 0) {
      exclusions.push({ productId: record.productId, channel: "", blocker: "NO_LISTING" });
      continue;
    }
    const tagKeys = normalizeTags(record.marketingTagKeys);
    for (const listing of record.listings) {
      const result = evaluateFunnelLink(record.product, listing);
      if (!result.eligible) {
        exclusions.push({ productId: record.productId, channel: listing.channel, blocker: result.blocker });
        continue;
      }
      // Same product may have multiple real listings in the same marketplace;
      // preserve distinct, independently validated listing links but omit identical repeats.
      const key = JSON.stringify([record.productId, result.channel, result.url]);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        productId: record.productId,
        title: record.title,
        category: record.category,
        tagKeys,
        destination: result.channel,
        marketplaceUrl: result.url,
        decision: "ELIGIBLE_FOR_REVIEW",
      });
    }
  }
  return { candidates, exclusions, requiresOwnerApproval: true, spendAuthorized: false };
}
