import type { ProductPhoto } from "@noctella/shared";
import { api, ApiError, uploadForm } from "./api";

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

/**
 * #424: one stable Idempotency-Key per logical upload (this File with this alt text, as the server binds the key to
 * actor, product, bytes and alt text). A retry after an ambiguous failure (no response, 5xx, 408/429, or the server
 * reporting the same upload still in progress / fence lost) reuses the key, so a lost response cannot create a second
 * photo. After success or a definitive rejection the key is released: the server ends that identity, and uploading the
 * file again is a new logical upload. With ownership fencing OFF the server ignores the header.
 */
const RETRYABLE_CONFLICT_CODES = ["PHOTO_OPERATION_IN_PROGRESS", "PHOTO_OPERATION_FENCE_LOST"];
export function productPhotoUploadFailureIsAmbiguous(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // network failure or lost response: the server may have committed
  return error.status >= 500 || error.status === 408 || error.status === 429 ||
    (error.status === 409 && RETRYABLE_CONFLICT_CODES.includes(error.code ?? ""));
}
export function createProductPhotoUploadKeys(newKey: () => string = () => crypto.randomUUID()) {
  const keys = new WeakMap<File, { key: string; altText: string }>();
  return {
    keyFor(file: File, altText: string): string {
      const known = keys.get(file);
      if (known && known.altText === altText) return known.key;
      const key = newKey();
      keys.set(file, { key, altText });
      return key;
    },
    settle(file: File, error?: unknown): void {
      if (error === undefined || !productPhotoUploadFailureIsAmbiguous(error)) keys.delete(file);
    },
  };
}

export const productPhotoApi = {
  upload: (productId: string, file: File, altText?: string, idempotencyKey?: string) =>
    uploadForm<ProductPhoto>(`/api/products/${productId}/photos`, productPhotoUploadForm(file, altText), idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  updateAltText: (productId: string, photoId: string, altText?: string) =>
    api.put<ProductPhoto>(`/api/products/${productId}/photos/${photoId}`, { altText }),
  setPrimary: (productId: string, photoId: string) =>
    api.post<ProductPhoto[]>(`/api/products/${productId}/photos/${photoId}/primary`, {}),
  reorder: (productId: string, photoIds: string[]) =>
    api.post<ProductPhoto[]>(`/api/products/${productId}/photos/reorder`, { photoIds }),
  delete: (productId: string, photoId: string) =>
    api.delete<ProductPhoto[]>(`/api/products/${productId}/photos/${photoId}`),
};
