import type { ProductPhoto } from "@noctella/shared";
import { api, uploadForm } from "./api";

export function productPhotoUploadForm(file: File, altText?: string): FormData {
  const form = new FormData();
  form.set("photo", file);
  if (altText) form.set("altText", altText);
  return form;
}

export function reorderProductPhotoIds(
  photos: readonly Pick<ProductPhoto, "id">[],
  photoId: string,
  direction: -1 | 1,
): string[] | null {
  const ids = photos.map(({ id }) => id);
  const current = ids.indexOf(photoId);
  const target = current + direction;
  if (current < 0 || target < 0 || target >= ids.length) return null;
  [ids[current], ids[target]] = [ids[target], ids[current]];
  return ids;
}

export function productPhotoCapabilities(photos: readonly ProductPhoto[], photoId: string) {
  const index = photos.findIndex((photo) => photo.id === photoId);
  const photo = photos[index];
  return {
    canMoveEarlier: index > 0,
    canMoveLater: index >= 0 && index < photos.length - 1,
    canSetPrimary: Boolean(photo && !photo.isPrimary),
    canDelete: Boolean(photo),
  };
}

export type ProductPhotoUploadState = "queued" | "uploading" | "processing" | "completed" | "failed";

export function productPhotoPublicationReadiness(photos: readonly ProductPhoto[]) {
  const ready = photos.filter((photo) => photo.processingStatus === "Ready" && Boolean(photo.url));
  return {
    ready: ready.length > 0 && ready.some((photo) => photo.isPrimary),
    readyPhotoCount: ready.length,
    hasPrimary: ready.some((photo) => photo.isPrimary),
    missingAltTextCount: ready.filter((photo) => !photo.altText?.trim()).length,
  };
}

export const productPhotoApi = {
  upload: (productId: string, file: File, altText?: string) =>
    uploadForm<ProductPhoto>(`/api/products/${productId}/photos`, productPhotoUploadForm(file, altText)),
  updateAltText: (productId: string, photoId: string, altText?: string) =>
    api.put<ProductPhoto>(`/api/products/${productId}/photos/${photoId}`, { altText }),
  setPrimary: (productId: string, photoId: string) =>
    api.post<ProductPhoto[]>(`/api/products/${productId}/photos/${photoId}/primary`, {}),
  reorder: (productId: string, photoIds: string[]) =>
    api.post<ProductPhoto[]>(`/api/products/${productId}/photos/reorder`, { photoIds }),
  delete: (productId: string, photoId: string) =>
    api.delete<ProductPhoto[]>(`/api/products/${productId}/photos/${photoId}`),
};
