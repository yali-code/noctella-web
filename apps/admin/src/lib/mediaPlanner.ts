import { api } from "./api";

export interface MediaPlanItem {
  id: string; itemIndex: number; contentType: "FEED_POST" | "REEL"; postFormat: string; plannedAt: string; timeBasis: string;
  product: { id: string; sku: string | null; title: string | null; category: string | null };
  photos: { id: string; url: string | null; hero: boolean }[]; heroPhotoId: string;
  caption: string; hashtags: string[]; hook: string | null; frameTexts: string[] | null; finalFrameText: string | null;
  reel: { status: string | null; previewPath: string | null } | null; rationale: string; status: string; version: number;
}
export interface MediaPlan {
  id: string; startDate: string; endDate: string; timezone: string; status: string; generatedAt: string; copySource: string;
  timeRecommendation: string; rationale: Record<string, string>; approvedAt: string | null; items: MediaPlanItem[];
}
export interface MediaPlannerReadiness {
  eligibleProductCount: number; requiredProductCount: number; productsWithReadyPhotos: number; instagramConnectionReady: boolean; socialPublishingReady: boolean;
  reelRendererReady: boolean; reelTextOverlayConfigured: boolean; reelPublishing: string; planExists: boolean; planStatus: string | null; planApproved: boolean; scheduledItemCount: number; blockers: string[];
}
export interface MediaPlanItemEdit { expectedVersion: number; productId?: string; photoIds?: string[]; heroPhotoId?: string; caption?: string; hashtags?: string[]; plannedAt?: string }

const base = "/api/media-planner";
const plan = (id: string) => `${base}/plans/${encodeURIComponent(id)}`;
export const mediaPlannerApi = {
  readiness: () => api.get<MediaPlannerReadiness>(`${base}/readiness`),
  latest: () => api.get<{ plan: MediaPlan | null }>(`${base}/plans/latest`),
  generate: (startDate?: string) => api.post<MediaPlan>(`${base}/plans`, startDate ? { startDate } : {}),
  editItem: (planId: string, itemId: string, edit: MediaPlanItemEdit) => api.patch<MediaPlan>(`${plan(planId)}/items/${encodeURIComponent(itemId)}`, edit),
  renderReel: (planId: string, itemId: string) => api.post<MediaPlan>(`${plan(planId)}/items/${encodeURIComponent(itemId)}/render-reel`, {}),
  approve: (planId: string) => api.post<MediaPlan>(`${plan(planId)}/approve`, {}),
  reject: (planId: string) => api.post<MediaPlan>(`${plan(planId)}/reject`, {}),
  schedule: (planId: string) => api.post<MediaPlan>(`${plan(planId)}/schedule`, {}),
};
