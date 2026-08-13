/**
 * Sprint 140: repository contracts for the normalized Product Marketing Tag taxonomy
 * (marketing_tags + product_marketing_tags). Plain, non-transaction-scoped reads/writes -
 * mirrors repositories/marketplace-preparation/drizzle.ts's own createDrizzleMarketplacePreparationRepository
 * shape (no locked-transaction concern exists here: Marketing Tags are never identity/inventory-
 * critical, so no optimistic-concurrency/locking primitive is needed for these writes).
 */
export interface MarketingTagRecord {
  id: string;
  key: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketingTagRepository {
  /** Insert-if-absent by canonical key - always returns the existing or newly-created row. */
  findOrCreateByKey(key: string, label: string): Promise<MarketingTagRecord>;
  /** All Marketing Tags currently related to the Product, ordered by creation. */
  listByProduct(productId: string): Promise<MarketingTagRecord[]>;
  /** True if the Product has at least one Marketing Tag relation - the empty-set-check gate for automatic AI writes. */
  hasAnyForProduct(productId: string): Promise<boolean>;
  /** Idempotent - inserting an already-existing (productId, marketingTagId) relation is a safe no-op. */
  addRelation(productId: string, marketingTagId: string): Promise<void>;
  /** Removes only the one (productId, tagId) relation - never deletes the global marketing_tags row. Returns whether a relation actually existed. */
  removeRelation(productId: string, marketingTagId: string): Promise<boolean>;
}
