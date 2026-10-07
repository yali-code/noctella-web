import type { SocialContent, SocialContentDraftInput, SocialContentStatus } from "@noctella/shared";
import { api } from "./api";

export interface PreparedImageSummary { id: string; sourcePhotoId: string; recipeVersion: string; outputPath: string }
export interface PublishingAttemptSummary {
  id: string; origin: "scheduled" | "direct"; status: string; providerEntryState: string | null; hasContainer: boolean;
  lastError: string | null; publishedAt: string | null; updatedAt: string; requiresManualReconciliation: boolean;
}
export interface PublishingChainApproval {
  id: string; preparedImageId: string; contentVersion: number; approvedAt: string; current: boolean;
  intent: { id: string; createdAt: string } | null;
  schedule: { id: string; requestedPublicationAt: string; createdAt: string } | null;
  execution: { id: string; createdAt: string } | null;
  job: { id: string; status: string; attemptCount: number; maxAttempts: number; lastError: string | null; runAfter: string; completedAt: string | null; updatedAt: string } | null;
  attempt: PublishingAttemptSummary | null;
}
export interface PublishingChain { content: { id: string; status: string; version: number }; preparedImages: PreparedImageSummary[]; approvals: PublishingChainApproval[] }
export interface PublishingReadiness {
  ready: boolean; mediaOriginAllowed: boolean; connection: string; missingConfiguration: string[]; checks: Record<string, string>;
}

const base = "/api/social/contents";
const contentPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
// Each request is one explicit domain action; a fresh requestId per click keeps retries idempotent server-side.
const requestId = () => crypto.randomUUID().toLowerCase();
export const socialContentApi = {
  list: (query: string) => api.get<{ items: SocialContent[]; page: number; hasMore: boolean }>(`${base}?${query}`),
  get: (id: string) => api.get<SocialContent>(contentPath(id)),
  create: (input: SocialContentDraftInput) => api.post<SocialContent>(base, input),
  edit: (id: string, input: SocialContentDraftInput, expectedVersion: number) => api.patch<SocialContent>(contentPath(id), { ...input, expectedVersion }),
  transition: (id: string, status: SocialContentStatus, expectedVersion: number) => api.post<SocialContent>(`${contentPath(id)}/status`, { status, expectedVersion }),
  publishingChain: (id: string) => api.get<PublishingChain>(`${contentPath(id)}/publishing-chain`),
  prepareImage: (id: string, photoId: string) => api.post<PreparedImageSummary>(`${contentPath(id)}/prepare-image`, { photoId }),
  approve: (id: string, preparedImageId: string, expectedVersion: number) =>
    api.post<{ id: string }>(`${contentPath(id)}/approve`, { preparedImageId, expectedVersion, requestId: requestId() }),
  createPublishIntent: (approvalId: string) => api.post<{ id: string }>(`${base}/publish-intents`, { approvalId, requestId: requestId() }),
  schedulePublication: (publishIntentId: string, requestedPublicationAt: string) =>
    api.post<{ id: string }>(`${base}/publish-schedules`, { publishIntentId, requestedPublicationAt, requestId: requestId() }),
  // Local-only readiness; never verifies against Instagram.
  publishingReadiness: () => api.get<PublishingReadiness>("/api/instagram/publishing-readiness"),
};
