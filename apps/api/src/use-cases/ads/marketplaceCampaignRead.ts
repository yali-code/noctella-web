import type { ProductAvailabilityProjection } from "../../repositories/product-read/types";
import { projectMarketplaceCampaignCandidates, type CampaignCandidateProjection, type CampaignProductFacts } from "./marketplaceCampaignCandidates";
import type { FunnelListingFacts } from "./marketplaceFunnelLinks";

/**
 * ADS-002C.2: read-only integration boundary over existing ERP contracts.
 * No provider API, DB writes, warehouse expiry command, stock mutation or ad spend.
 * In particular, product-read/drizzle currently returns reservedStockSupported=false;
 * that projection MUST NOT be treated as spend-safe inventory.
 */
export interface TrustedMarketplaceCampaignReaders {
  readProduct(productId: string): Promise<{
    id: string; title: string; status: string; salePausedAt: string | null; category: string | null;
  } | null>;
  readAvailability(productId: string): Promise<ProductAvailabilityProjection | null>;
  readMarketingTags(productId: string): Promise<readonly { key: string }[]>;
  readExternalListings(productId: string): Promise<readonly FunnelListingFacts[]>;
}

export interface TrustedCampaignCandidateReadResult {
  readonly projection: CampaignCandidateProjection;
  readonly inventoryVerification: "VERIFIED" | "UNVERIFIED";
}

/** The only trusted quantity is a coherent projection with reservation support. */
export function verifiedAvailableQuantity(availability: ProductAvailabilityProjection | null): number | null {
  if (!availability || availability.reservedStockSupported !== true) return null;
  const { physicalStock, reservedStock, availableStock, availableQuantity } = availability;
  if (![physicalStock, reservedStock, availableStock, availableQuantity].every(Number.isSafeInteger)) return null;
  if (physicalStock < 0 || reservedStock < 0 || reservedStock > physicalStock) return null;
  if (availableStock !== physicalStock - reservedStock || availableQuantity !== availableStock) return null;
  return availableQuantity;
}

/**
 * Use a trusted server-side reader to assemble the original pure projection.
 * Fail closed if the inventory read is incomplete. Do not expose this through
 * a public route before stock reservation and marketplace status audits.
 */
export async function readMarketplaceCampaignCandidatesForProduct(
  productId: string,
  readers: TrustedMarketplaceCampaignReaders,
): Promise<TrustedCampaignCandidateReadResult> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(productId)) {
    return {
      projection: {
        candidates: [], exclusions: [{ productId, channel: "", blocker: "INVALID_PRODUCT_ID" }],
        requiresOwnerApproval: true, spendAuthorized: false,
      },
      inventoryVerification: "UNVERIFIED",
    };
  }
  const [product, availability] = await Promise.all([
    readers.readProduct(productId),
    readers.readAvailability(productId),
  ]);
  if (!product || product.id !== productId) {
    return { projection: { candidates: [], exclusions: [{ productId, channel: "", blocker: "PRODUCT_NOT_PUBLISHED" }], requiresOwnerApproval: true, spendAuthorized: false }, inventoryVerification: "UNVERIFIED" };
  }
  const stock = availability?.productId === productId ? verifiedAvailableQuantity(availability) : null;
  // Avoid external lookups for products already known not to qualify.
  if (product.status !== "published" || product.salePausedAt || stock === null || stock < 1) {
    const facts: CampaignProductFacts = {
      productId, title: product.title, category: product.category, marketingTagKeys: [],
      product: { status: product.status, salePausedAt: product.salePausedAt, availableQuantity: stock },
      // Supply one inert listing to reuse ADS-002A's fail-closed blocker logic.
      listings: [{ channel: "ebay", externalStatus: "inactive", externalListingId: "", externalListingUrl: null }],
    };
    return { projection: projectMarketplaceCampaignCandidates([facts]), inventoryVerification: stock === null ? "UNVERIFIED" : "VERIFIED" };
  }
  const [tags, listings] = await Promise.all([
    readers.readMarketingTags(productId), readers.readExternalListings(productId),
  ]);
  const facts: CampaignProductFacts = {
    productId, title: product.title, category: product.category, marketingTagKeys: tags.map(x => x.key),
    product: { status: product.status, salePausedAt: product.salePausedAt, availableQuantity: stock },
    listings,
  };
  return { projection: projectMarketplaceCampaignCandidates([facts]), inventoryVerification: "VERIFIED" };
}
