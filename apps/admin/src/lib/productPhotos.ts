import type { ProductPhoto } from "@noctella/shared";
import { api, uploadForm } from "./api";

export function productPhotoUploadForm(file: File, altText?: string): FormData {
  const form = new FormData();
  form.set("photo", file);
  if (altText) form.set("altText", altText);
  return form;
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
