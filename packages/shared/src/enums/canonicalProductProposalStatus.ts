/** Sprint 148: mirrors MarketplacePreparationStatus exactly - the isolated canonical Product AI proposal lifecycle (see enums/marketplacePreparationStatus.ts). Deliberately a separate enum, not a shared/reused one: canonical Product proposals are never channel-scoped and must never be confused with marketplace_preparations rows. */
export enum CanonicalProductProposalStatus {
  Pending = "pending",
  Applied = "applied",
}

export const CANONICAL_PRODUCT_PROPOSAL_STATUS_VALUES: CanonicalProductProposalStatus[] = Object.values(CanonicalProductProposalStatus);
