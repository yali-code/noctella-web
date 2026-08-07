/**
 * Sprint 107: repository contracts for the in-flight, unapproved AI
 * marketplace-preparation proposal (marketplace_preparations) - one row per
 * (productId, channel). Narrowly scoped to this one purpose; approved
 * content is copied onto the existing Product marketplace-field columns by
 * use-cases/marketplace-preparation/useCases.ts, never persisted here.
 *
 * Split into two contracts, mirroring the established AI Draft precedent
 * exactly (services/aiDrafts.ts's plain sequential db calls for generation
 * vs. repositories/ai-draft/types.ts's narrow, transaction-scoped approval
 * repository): generation/read never need transaction-scoped sync/async
 * duality (no locked-transaction concern exists for a single-row upsert with
 * no field-level review state or fingerprint dimension to protect), while
 * approval's atomic conditional claim must run inside the approval
 * transaction and therefore does need it.
 */
export type MarketplacePreparationRecord = Record<string, string | number | boolean | Date | null>;

/**
 * Sprint 107: the twelve channel-specific suggestion fields - direct,
 * single-value suggestions (mirroring ai_intake_proposals' Sprint 106
 * AiIntakeProposalExpandedSuggestions precedent: flat suggestion columns,
 * not per-field Accept/Edit/Reject/Pending tracking). Only the fields
 * relevant to the row's own `channel` are ever populated by a real provider
 * call; the rest remain null.
 */
export interface MarketplacePreparationSuggestedFields {
  suggestedTitle: string | null;
  suggestedDescription: string | null;
  suggestedConditionDescription: string | null; // eBay
  suggestedItemSpecifics: string | null; // eBay
  suggestedTags: string | null; // Etsy, JSON-encoded string[]
  suggestedMaterials: string | null; // Etsy
  suggestedStyle: string | null; // Etsy
  suggestedOccasion: string | null; // Etsy
  suggestedShortDescription: string | null; // Noctella Web
  suggestedSeoTitle: string | null; // Noctella Web
  suggestedMetaDescription: string | null; // Noctella Web
  suggestedFocusKeyword: string | null; // Noctella Web
}

export interface MarketplacePreparationUpsertInput extends MarketplacePreparationSuggestedFields {
  /** Used only when no row for (productId, channel) exists yet - an existing row keeps its own id. */
  id: string;
  productId: string;
  channel: string;
  baseProductUpdatedAt: string;
  providerName: string;
  promptVersion: string;
  generatedAt: string;
}

/**
 * Plain, non-transaction-scoped read/generate repository - always awaitable
 * regardless of driver (mirrors services/aiDrafts.ts's own direct `await
 * db.select()/db.insert()` calls, which work identically for the SQLite and
 * Postgres DbClient outside of an explicit db.transaction() callback).
 */
export interface MarketplacePreparationRepository {
  findByProductIdAndChannel(productId: string, channel: string): Promise<MarketplacePreparationRecord | null>;
  /**
   * Insert-if-absent, else refresh-in-place - always resets status to
   * "pending" and clears appliedAt/appliedByAdminUserId, regardless of the
   * row's prior status. Never conflicts: a (productId, channel) row is
   * always safely (re)generatable.
   */
  upsert(input: MarketplacePreparationUpsertInput): Promise<MarketplacePreparationRecord>;
}

export interface MarketplacePreparationApproveInput {
  id: string;
  appliedAt: string;
  appliedByAdminUserId: string;
  updatedAt: string;
}

export interface MarketplacePreparationApproveConflict {
  field: "id" | "status";
  message: string;
}

export interface MarketplacePreparationApproveResult {
  updated: boolean;
  row?: MarketplacePreparationRecord;
  conflict?: MarketplacePreparationApproveConflict;
}

/** Narrow, approval-only repository - used exclusively inside the approval transaction (see use-cases/marketplace-preparation/useCases.ts), mirroring repositories/ai-draft/types.ts's AiDraftApprovalRepository exactly. */
export interface MarketplacePreparationApprovalRepository {
  findById(id: string): Promise<MarketplacePreparationRecord | null>;
  /** Atomic conditional claim: UPDATE ... WHERE id = ? AND status = 'pending'. */
  claimAndApprove(input: MarketplacePreparationApproveInput): Promise<MarketplacePreparationApproveResult>;
}

export type SynchronousMarketplacePreparationApprovalRepository = {
  [Key in keyof MarketplacePreparationApprovalRepository]: MarketplacePreparationApprovalRepository[Key] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Result
    : MarketplacePreparationApprovalRepository[Key];
};
