import type { PublishChannel, PublishPreview, PublishReadinessSummary, PublishValidation } from "@noctella/shared";
import { api } from "./api";

export function publishPayload(channel: PublishChannel) {
  return { channel };
}

export function publishChannelQuery(channel: PublishChannel): string {
  return new URLSearchParams({ channel }).toString();
}

export function readinessByChannel(summary: PublishReadinessSummary): Record<string, PublishValidation> {
  return Object.fromEntries(summary.channels.map((validation) => [validation.channel, validation]));
}

export function issueMessages(validation: PublishValidation, type: "errors" | "warnings"): string[] {
  return validation[type].map((issue) => issue.message);
}

export const publishingApi = {
  summary: (productId: string) => api.get<PublishReadinessSummary>(`/api/products/${productId}/publish`),
  validate: (productId: string, channel: PublishChannel) =>
    api.post<PublishValidation>(`/api/products/${productId}/publish/validate`, publishPayload(channel)),
  preview: (productId: string, channel: PublishChannel) =>
    api.post<PublishPreview>(`/api/products/${productId}/publish/preview`, publishPayload(channel)),
};
