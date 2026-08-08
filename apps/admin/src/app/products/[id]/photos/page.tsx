"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, resolveApiAssetUrl } from "@/lib/api";
import { productPhotoApi } from "@/lib/productPhotos";
import type { ProductDetail } from "@/lib/types";

export default function ProductPhotosPage({ params }: { params: { id: string } }) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [altText, setAltText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setProduct(await api.get<ProductDetail>(`/api/products/${params.id}`));
  }, [params.id]);

  useEffect(() => {
    load().catch((err) => setMessage(err.message ?? "Failed to load photos"));
  }, [load]);

  /**
   * Sprint 112: uploads every selected file sequentially - one awaited
   * productPhotoApi.upload(...) call per file, reusing the existing
   * single-photo endpoint unchanged, never in parallel - so the backend's
   * existing sortOrder/primary-photo semantics (computed per request inside
   * a per-product lock, see services/products.ts's uploadProductPhoto)
   * remain authoritative and follow the selected order. A failure on one
   * file does not stop the remaining files from being attempted; already
   * -successful uploads are never retried or rolled back.
   */
  async function uploadPhotos(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setUploading(true);
    setMessage(null);
    let successCount = 0;
    const failed: string[] = [];
    for (const selected of files) {
      try {
        await productPhotoApi.upload(params.id, selected, altText);
        successCount += 1;
      } catch {
        failed.push(selected.name);
      }
    }
    setFiles([]);
    setAltText("");
    setUploading(false);
    setMessage(
      failed.length === 0
        ? `Uploaded ${successCount} photo${successCount === 1 ? "" : "s"}.`
        : `Uploaded ${successCount} of ${successCount + failed.length} photo(s). Failed: ${failed.join(", ")}.`,
    );
    await load();
  }

  async function setPrimary(photoId: string) {
    await productPhotoApi.setPrimary(params.id, photoId);
    await load();
  }

  async function remove(photoId: string) {
    await productPhotoApi.delete(params.id, photoId);
    await load();
  }

  async function move(photoId: string, direction: -1 | 1) {
    if (!product) return;
    const ids = product.photos.map((photo) => photo.id);
    const index = ids.indexOf(photoId);
    const next = index + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    await productPhotoApi.reorder(params.id, ids);
    await load();
  }

  if (!product) return <p>Loading...</p>;

  return (
    <div>
      <Link href={`/products/${params.id}`}>← Back to product</Link>
      <h1>Manage Photos — {product.title}</h1>
      {message && <p style={{ color: "#c86a6a" }}>{message}</p>}
      <form onSubmit={uploadPhotos} className="noctella-panel" style={{ padding: 20, margin: "20px 0", display: "grid", gap: 12 }}>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
        <input value={altText} onChange={(event) => setAltText(event.target.value)} placeholder="Alt text" style={{ padding: 10 }} />
        <button type="submit" disabled={files.length === 0 || uploading}>
          {uploading ? "Uploading..." : files.length > 1 ? `Upload ${files.length} photos` : "Upload photo"}
        </button>
        <small>JPEG, PNG, or WebP. Max 10 MB each. Select multiple files to upload them one after another. Images are normalized to WebP at 2000px plus 400px thumbnails.</small>
      </form>
      <div style={{ display: "grid", gap: 16 }}>
        {product.photos.map((photo, index) => (
          <div key={photo.id} className="noctella-panel" style={{ padding: 16, display: "flex", gap: 16, alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={resolveApiAssetUrl(photo.thumbnailUrl)} alt={photo.altText ?? product.title} style={{ width: 96, height: 96, objectFit: "cover" }} />
            <div style={{ flex: 1 }}>
              <strong>{photo.isPrimary ? "Primary" : `Photo ${index + 1}`}</strong>
              <p>{photo.altText || "No alt text"}</p>
              <small>{photo.width}×{photo.height} · {photo.mimeType}</small>
            </div>
            <button onClick={() => move(photo.id, -1)} disabled={index === 0}>↑</button>
            <button onClick={() => move(photo.id, 1)} disabled={index === product.photos.length - 1}>↓</button>
            <button onClick={() => setPrimary(photo.id)} disabled={photo.isPrimary}>Set primary</button>
            <button onClick={() => remove(photo.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
