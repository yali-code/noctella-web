import type { AiIntakeFieldDecision, AiIntakePhoto, AiIntakeProposalReview, AiProductIntake, Product } from "@noctella/shared";
import { api, ApiError, resolveApiAssetUrl, uploadForm } from "./api";
import type { PaginatedResult } from "./types";

/**
 * Sprint 97: the single place that knows the AI Product Intake endpoint
 * paths and payload shapes - pages/sections call these functions instead of
 * embedding route strings, mirroring lib/productPhotos.ts's established
 * convention. Every JSON operation reuses the existing api helper (so
 * ApiError propagates exactly as it does everywhere else); uploadPhoto
 * reuses uploadForm; fetchPhotoContent is the one exception (a binary
 * response, not JSON) and replicates api.ts's error-shape/401-redirect
 * behavior directly, since that logic is not exported from api.ts.
 */

export interface ListAiProductIntakesParams {
  page?: number;
  pageSize?: number;
  status?: string;
}

export interface SaveAiIntakeAsDraftInput {
  sku: string;
  categoryId: string;
  type: string;
  priceEur: number;
  stockQuantity?: number;
  expectedProposalUpdatedAt: string;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Never a client-side router push - matches api.ts's own redirectToLoginFromBrowser exactly, duplicated here because that helper is not exported. */
function redirectToLoginFromBrowser(): void {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
}

/** Binary (image/webp) response - bypasses the JSON-only api.ts request() helper, same reasoning as uploadForm's separate fetch. */
async function fetchPhotoContentBlob(intakeId: string, photoId: string): Promise<Blob> {
  const url = resolveApiAssetUrl(`/api/ai-product-intakes/${intakeId}/photos/${photoId}/content`);
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    if (res.status === 401) redirectToLoginFromBrowser();
    const isJson = res.headers.get("content-type")?.includes("application/json");
    const body = isJson ? await res.json().catch(() => undefined) : undefined;
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.details, typeof body?.code === "string" ? body.code : undefined, isJson ? body : undefined);
  }
  return res.blob();
}

export const aiProductIntakesApi = {
  list: (params: ListAiProductIntakesParams = {}) =>
    api.get<PaginatedResult<AiProductIntake>>(
      `/api/ai-product-intakes${toQueryString({ page: params.page, pageSize: params.pageSize, status: params.status })}`,
    ),
  create: () => api.post<AiProductIntake>("/api/ai-product-intakes", {}),
  get: (id: string) => api.get<AiProductIntake>(`/api/ai-product-intakes/${id}`),
  cancel: (id: string, cancellationReason?: string) =>
    api.post<AiProductIntake>(`/api/ai-product-intakes/${id}/cancel`, cancellationReason ? { cancellationReason } : {}),
  listPhotos: (id: string) => api.get<AiIntakePhoto[]>(`/api/ai-product-intakes/${id}/photos`),
  uploadPhoto: (id: string, file: File) => {
    const form = new FormData();
    form.set("photo", file);
    return uploadForm<AiIntakePhoto>(`/api/ai-product-intakes/${id}/photos`, form);
  },
  deletePhoto: (id: string, photoId: string) => api.delete<void>(`/api/ai-product-intakes/${id}/photos/${photoId}`),
  fetchPhotoContent: (id: string, photoId: string) => fetchPhotoContentBlob(id, photoId),
  generateProposal: (id: string) => api.post<AiIntakeProposalReview>(`/api/ai-product-intakes/${id}/generate`, {}),
  getProposal: (id: string) => api.get<AiIntakeProposalReview>(`/api/ai-product-intakes/${id}/proposal`),
  updateFieldReview: (
    id: string,
    field: "title" | "description" | "keywords",
    decision: AiIntakeFieldDecision,
    expectedUpdatedAt: string,
    value?: string | string[],
  ) =>
    api.patch<AiIntakeProposalReview>(`/api/ai-product-intakes/${id}/proposal/fields/${field}`, {
      decision,
      expectedUpdatedAt,
      ...(value !== undefined ? { value } : {}),
    }),
  saveAsDraft: (id: string, input: SaveAiIntakeAsDraftInput) => api.post<Product>(`/api/ai-product-intakes/${id}/save-as-draft`, input),
  finalizePhotos: (id: string, primaryIntakePhotoId?: string) =>
    api.post<Product>(`/api/ai-product-intakes/${id}/finalize-photos`, primaryIntakePhotoId !== undefined ? { primaryIntakePhotoId } : {}),
};
