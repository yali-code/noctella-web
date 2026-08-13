import type { MarketingTag } from "@noctella/shared";
import { api } from "./api";

/**
 * Sprint 140: Product-scoped Marketing Tags - explicit GET/POST/DELETE only, mirroring the API's
 * approved Admin-wins ownership model (no replace-all call exists server-side, so none is offered
 * here either).
 */
export const marketingTagsApi = {
  list: (productId: string) => api.get<MarketingTag[]>(`/api/products/${productId}/marketing-tags`),
  add: (productId: string, label: string) => api.post<MarketingTag>(`/api/products/${productId}/marketing-tags`, { label }),
  remove: (productId: string, tagId: string) => api.delete<void>(`/api/products/${productId}/marketing-tags/${tagId}`),
};
