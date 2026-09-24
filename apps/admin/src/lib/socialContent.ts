import type { SocialContent, SocialContentDraftInput, SocialContentStatus } from "@noctella/shared";
import { api } from "./api";

const base = "/api/social/contents";
export const socialContentApi = {
  list: (query: string) => api.get<{ items: SocialContent[]; page: number; hasMore: boolean }>(`${base}?${query}`),
  get: (id: string) => api.get<SocialContent>(`${base}/${encodeURIComponent(id)}`),
  create: (input: SocialContentDraftInput) => api.post<SocialContent>(base, input),
  edit: (id: string, input: SocialContentDraftInput, expectedVersion: number) => api.patch<SocialContent>(`${base}/${encodeURIComponent(id)}`, { ...input, expectedVersion }),
  transition: (id: string, status: SocialContentStatus, expectedVersion: number) => api.post<SocialContent>(`${base}/${encodeURIComponent(id)}/status`, { status, expectedVersion }),
};
