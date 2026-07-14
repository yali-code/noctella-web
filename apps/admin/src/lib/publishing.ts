import { PublishChannel, type Product, type PublishPayload, type PublishPreview, type PublishValidation } from "@noctella/shared";
import { api } from "./api";

export const ADMIN_PUBLISH_CHANNELS = [
  { value: PublishChannel.Ebay, label: "eBay" },
  { value: PublishChannel.Etsy, label: "Etsy" },
  { value: PublishChannel.NoctellaWeb, label: "Noctella Web" },
] as const;

export function channelLabel(channel: PublishChannel): string {
  return ADMIN_PUBLISH_CHANNELS.find((item) => item.value === channel)?.label ?? channel;
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
