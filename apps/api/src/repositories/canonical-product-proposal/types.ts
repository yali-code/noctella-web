/**
 * Sprint 148: repository contracts for the isolated, non-channel-scoped canonical Product AI
 * proposal (canonical_product_ai_proposals) - one row per productId. Mirrors
 * repositories/marketplace-preparation/types.ts exactly (same split rationale: generation/read
 * never needs transaction-scoped sync/async duality; approval's atomic conditional claim does).
 * Approved content is never persisted here - use-cases/canonical-product-proposal/useCases.ts
 * copies only the admin-SELECTED suggested values onto the existing Product columns and
 * additively onto Marketing Tags.
 */
export type CanonicalProductProposalRecord = Record<string, string | number | boolean | Date | null>;

/**
 * Sprint 148: the flat suggestion fields - Product Details, Physical Information, and Marketing
 * Tags. Mirrors MarketplacePreparationSuggestedFields' flat-columns precedent (not per-field
 * Accept/Edit/Reject/Pending tracking). Physical fields are null whenever the evidence rule
 * (Sprint 148 Architecture Review E) was not satisfied at generation time - never a fabricated
 * estimate.
 */
export interface CanonicalProductProposalSuggestedFields {
  suggestedBrand: string | null;
  suggestedModel: string | null;
  suggestedManufacturer: string | null;
  suggestedCountryOfOrigin: string | null;
  suggestedPeriod: string | null;
  suggestedMaterials: string | null;
  suggestedDescription: string | null;
  suggestedProductStory: string | null;
  suggestedCondition: string | null;
  suggestedConditionDescription: string | null;
  suggestedLengthValue: number | null;
  suggestedWidthValue: number | null;
  suggestedHeightValue: number | null;
  suggestedDimensionUnit: string | null;
  suggestedWeightValue: number | null;
  suggestedWeightUnit: string | null;
  suggestedMarketingTags: string | null; // JSON-encoded string[]
}

export interface CanonicalProductProposalUpsertInput extends CanonicalProductProposalSuggestedFields {
  /** Used only when no row for productId exists yet - an existing row keeps its own id. */
  id: string;
  productId: string;
  baseProductUpdatedAt: string;
  providerName: string;
  promptVersion: string;
  generatedAt: string;
}

/** Plain, non-transaction-scoped read/generate repository - mirrors MarketplacePreparationRepository exactly. */
export interface CanonicalProductProposalRepository {
  findByProductId(productId: string): Promise<CanonicalProductProposalRecord | null>;
  /**
   * Insert-if-absent, else refresh-in-place - always resets status to "pending" and clears
   * appliedAt/appliedByAdminUserId, regardless of the row's prior status. Never conflicts: a
   * productId row is always safely (re)generatable, and a fresh baseProductUpdatedAt/updatedAt
   * establishes a new freshness identity so an older client cannot Accept a stale proposal.
   */
  upsert(input: CanonicalProductProposalUpsertInput): Promise<CanonicalProductProposalRecord>;
}

export interface CanonicalProductProposalApproveInput {
  id: string;
  appliedAt: string;
  appliedByAdminUserId: string;
  updatedAt: string;
}

export interface CanonicalProductProposalApproveConflict {
  field: "id" | "status";
  message: string;
}

export interface CanonicalProductProposalApproveResult {
  updated: boolean;
  row?: CanonicalProductProposalRecord;
  conflict?: CanonicalProductProposalApproveConflict;
}

/** Narrow, approval-only repository - used exclusively inside the Accept transaction. */
export interface CanonicalProductProposalApprovalRepository {
  findById(id: string): Promise<CanonicalProductProposalRecord | null>;
  /** Atomic conditional claim: UPDATE ... WHERE id = ? AND status = 'pending'. */
  claimAndApply(input: CanonicalProductProposalApproveInput): Promise<CanonicalProductProposalApproveResult>;
}

export type SynchronousCanonicalProductProposalApprovalRepository = {
  [Key in keyof CanonicalProductProposalApprovalRepository]: CanonicalProductProposalApprovalRepository[Key] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Result
    : CanonicalProductProposalApprovalRepository[Key];
};
