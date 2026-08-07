import { PublishChannel, type MarketplacePreparation, type Product, type PublishPayload, type PublishPreview, type PublishValidation } from "@noctella/shared";
import { api } from "./api";
import { MARKETPLACE_CHANNELS } from "./marketplaces";

export const ADMIN_PUBLISH_CHANNELS = [
  { value: PublishChannel.Ebay, label: "eBay" },
  { value: PublishChannel.Etsy, label: "Etsy" },
  { value: PublishChannel.NoctellaWeb, label: "Noctella Web" },
] as const;

export function channelLabel(channel: PublishChannel): string {
  return ADMIN_PUBLISH_CHANNELS.find((item) => item.value === channel)?.label ?? channel;
}

/**
 * Sprint 84: true only for channels that go through the external-marketplace OAuth/
 * MarketplaceConnection flow (eBay/Etsy). Noctella Web is our own direct storefront and never
 * has - or needs - a MarketplaceConnection, so the publishing page must not gate Execute Publish
 * or show connection status for it. Reuses MARKETPLACE_CHANNELS (the same list already used by
 * the marketplace-connections management page) instead of duplicating it.
 */
export function requiresMarketplaceConnection(channel: PublishChannel): boolean {
  return MARKETPLACE_CHANNELS.includes(channel);
}

export function getChannelDraftTitle(product: Product, channel: PublishChannel): string {
  if (channel === PublishChannel.Ebay) return product.ebayTitle ?? product.title;
  if (channel === PublishChannel.Etsy) return product.etsyTitle ?? product.title;
  return product.wooProductName ?? product.title;
}

export function getChannelDraftPrice(product: Product, channel: PublishChannel): number {
  if (channel === PublishChannel.Ebay) return product.ebayListingPriceEur ?? product.priceEur;
  if (channel === PublishChannel.Etsy) return product.etsyListingPriceEur ?? product.priceEur;
  return product.wooListingPriceEur ?? product.priceEur;
}

export function payloadSummary(payload?: PublishPayload): string {
  if (!payload) return "Payload unavailable until validation passes.";
  return `${payload.title} — €${payload.priceEur.toFixed(2)} (${payload.listingStatus})`;
}

export const publishingApi = {
  getPreview: (productId: string, channel: PublishChannel) => api.get<PublishPreview>(`/api/products/${productId}/publish?channel=${channel}`),
  validate: (productId: string, channel: PublishChannel) => api.post<PublishValidation>(`/api/products/${productId}/publish/validate`, { channel }),
  preview: (productId: string, channel: PublishChannel) => api.post<PublishPreview>(`/api/products/${productId}/publish/preview`, { channel }),
};

/**
 * Sprint 107: the admin-reviewed/edited final field values submitted at
 * approval time - mirrors the API's ApproveMarketplacePreparationFieldInput
 * contract exactly (validation/marketplacePreparation.ts). Only the fields
 * relevant to the selected channel are ever read server-side.
 */
export interface ApproveMarketplacePreparationInput {
  channel: PublishChannel;
  expectedProposalUpdatedAt: string;
  title?: string;
  description?: string;
  conditionDescription?: string;
  itemSpecifics?: string;
  tags?: string[];
  materials?: string;
  style?: string;
  occasion?: string;
  shortDescription?: string;
  seoTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
}

/**
 * Sprint 107: Marketplace Preparation - the AI-assisted step strictly before
 * the existing, unchanged publish preview/validate/execute calls above.
 * Never calls execute - approval only returns the current canonical
 * Product with its marketplace fields updated for the one selected channel.
 */
export const marketplacePreparationApi = {
  generate: (productId: string, channel: PublishChannel) => api.post<MarketplacePreparation>(`/api/products/${productId}/marketplace-preparation`, { channel }),
  get: (productId: string, channel: PublishChannel) => api.get<MarketplacePreparation>(`/api/products/${productId}/marketplace-preparation?channel=${channel}`),
  approve: (productId: string, input: ApproveMarketplacePreparationInput) => api.post<Product>(`/api/products/${productId}/marketplace-preparation/approve`, input),
};
