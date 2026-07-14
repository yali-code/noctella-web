import { PublishChannel, PublishJobStatus, type ExternalListing, type MarketplaceConnection, type PublishExecutionResult, type PublishJob } from "@noctella/shared";
import { api } from "./api";
export const MARKETPLACE_CHANNELS = [PublishChannel.Ebay, PublishChannel.Etsy];
export function safeError(value?: string) { return value ? value.replace(/[A-Za-z0-9+/=_-]{6,}/g, "[redacted]") : ""; }
export function canRetry(job: Pick<PublishJob, "status" | "attemptCount">) { return job.status === PublishJobStatus.RetryPending && job.attemptCount < 3; }
export function externalListingLink(listing: ExternalListing) { return listing.externalListingUrl ?? `External ID: ${listing.externalListingId}`; }
export const marketplaceApi = {
  listConnections: () => api.get<MarketplaceConnection[]>("/api/marketplaces/connections"),
  connect: (channel: PublishChannel) => api.post<{ authorizationUrl: string; state: string }>(`/api/marketplaces/${channel}/connect`, {}),
  verify: (channel: PublishChannel) => api.post(`/api/marketplaces/${channel}/verify`, {}),
  refresh: (channel: PublishChannel) => api.post<MarketplaceConnection>(`/api/marketplaces/${channel}/refresh`, {}),
  disconnect: (channel: PublishChannel) => api.delete<MarketplaceConnection | null>(`/api/marketplaces/${channel}/disconnect`),
  executePublish: (productId: string, channel: PublishChannel) => api.post<PublishExecutionResult>(`/api/products/${productId}/publish/execute`, { channel }),
  listJobs: () => api.get<PublishJob[]>("/api/publish-jobs"),
  getJob: (id: string) => api.get<{ job: PublishJob; attempts: unknown[] }>(`/api/publish-jobs/${id}`),
  retry: (id: string) => api.post<PublishExecutionResult>(`/api/publish-jobs/${id}/retry`, {}),
  externalListings: (productId: string) => api.get<ExternalListing[]>(`/api/products/${productId}/external-listings`),
};
