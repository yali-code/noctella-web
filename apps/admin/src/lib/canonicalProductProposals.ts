import type { CanonicalProductProposal, Product } from "@noctella/shared";
import { api } from "./api";

/**
 * Sprint 148: the explicit accepted-selection contract - mirrors the API's
 * AcceptCanonicalProductProposalInput/validation/canonicalProductProposal.ts's
 * acceptCanonicalProductProposalSchema exactly. Never "apply every suggested field" - the server
 * intersects selectedProductFields against its own allowlist and selectedMarketingTags against
 * the proposal's own stored suggestions.
 */
export interface AcceptCanonicalProductProposalInput {
  expectedProposalUpdatedAt: string;
  selectedProductFields: string[];
  selectedMarketingTags: string[];
}

/**
 * Sprint 148: Canonical Product & Physical AI Suggestions - a dedicated, isolated proposal flow,
 * never a marketplace-preparation pseudo-channel. Generate/regenerate never mutates the Product;
 * Accept returns the current canonical Product with only the selected fields applied.
 */
export const canonicalProductProposalApi = {
  generate: (productId: string) => api.post<CanonicalProductProposal>(`/api/products/${productId}/canonical-ai-proposal`, {}),
  get: (productId: string) => api.get<CanonicalProductProposal>(`/api/products/${productId}/canonical-ai-proposal`),
  accept: (productId: string, input: AcceptCanonicalProductProposalInput) =>
    api.post<Product>(`/api/products/${productId}/canonical-ai-proposal/accept`, input),
};
