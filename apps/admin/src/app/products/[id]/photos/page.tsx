"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, resolveApiAssetUrl } from "@/lib/api";
import { productPhotoApi, productPhotoPublicationReadiness, reorderProductPhotoIds, type ProductPhotoUploadState } from "@/lib/productPhotos";
import type { ProductDetail } from "@/lib/types";

export default function ProductPhotosPage({ params }: { params: { id: string } }) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [altText, setAltText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null);
  const [altDrafts, setAltDrafts] = useState<Record<string, string>>({});
  const [uploadStates, setUploadStates] = useState<Record<string, ProductPhotoUploadState>>({});

  const load = useCallback(async () => {
    const next = await api.get<ProductDetail>(`/api/products/${params.id}`);
    setProduct(next);
    setAltDrafts(Object.fromEntries(next.photos.map((photo) => [photo.id, photo.altText ?? ""])));
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
    setUploadStates(Object.fromEntries(files.map((file) => [file.name, "queued"])));
    for (const selected of files) {
      try {
        setUploadStates((current) => ({ ...current, [selected.name]: "uploading" }));
        await productPhotoApi.upload(params.id, selected, altText);
        setUploadStates((current) => ({ ...current, [selected.name]: "processing" }));
        successCount += 1;
        setUploadStates((current) => ({ ...current, [selected.name]: "completed" }));
      } catch (error) {
        setUploadStates((current) => ({ ...current, [selected.name]: "failed" }));
        failed.push(selected.name);
        setMessage(error instanceof Error ? `Upload failed for ${selected.name}: ${error.message}` : `Upload failed for ${selected.name}.`);
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
    await mutate(photoId, "set primary photo", () => productPhotoApi.setPrimary(params.id, photoId));
  }

  async function remove(photoId: string) {
    const photo = product?.photos.find((item) => item.id === photoId);
    if (!photo || !window.confirm(`Delete ${photo.filename}? This cannot be undone.`)) return;
    await mutate(photoId, "delete photo", () => productPhotoApi.delete(params.id, photoId));
  }

  async function move(photoId: string, direction: -1 | 1) {
    if (!product) return;
    const ids = reorderProductPhotoIds(product.photos, photoId, direction);
    if (!ids) return;
    await mutate(photoId, "reorder photos", () => productPhotoApi.reorder(params.id, ids));
  }

  async function mutate(photoId: string, action: string, operation: () => Promise<unknown>) {
    if (busyPhotoId) return;
    setBusyPhotoId(photoId); setMessage(null);
    try { await operation(); await load(); setMessage(`Successfully completed: ${action}.`); }
    catch (error) { setMessage(error instanceof Error ? `Failed to ${action}: ${error.message}` : `Failed to ${action}.`); }
    finally { setBusyPhotoId(null); }
  }

  async function saveAltText(photoId: string) {
    await mutate(photoId, "save alt text", () => productPhotoApi.updateAltText(params.id, photoId, altDrafts[photoId]?.trim() || undefined));
  }

  if (!product) return <p>Loading...</p>;

  return (
    <div>
      <Link href={`/products/${params.id}`}>← Back to product</Link>
      <h1>Manage Photos — {product.title}</h1>
      {message && <p role="status" aria-live="polite" style={{ color: "#c86a6a" }}>{message}</p>}
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
        {Object.entries(uploadStates).map(([name, state]) => <small key={name} role="status">{name}: {state}</small>)}
      </form>
      {(() => { const readiness = productPhotoPublicationReadiness(product.photos); return <section aria-label="Publication photo readiness"><strong>{readiness.ready ? "Photo-ready for publication" : "Photos need attention"}</strong><p>{readiness.readyPhotoCount} ready · primary {readiness.hasPrimary ? "set" : "missing"} · {readiness.missingAltTextCount} missing alt text</p></section>; })()}
      <div style={{ display: "grid", gap: 16 }}>
        {product.photos.map((photo, index) => (
          <div key={photo.id} className="noctella-panel" style={{ padding: 16, display: "flex", gap: 16, alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={resolveApiAssetUrl(photo.thumbnailUrl)} alt={photo.altText ?? product.title} style={{ width: 96, height: 96, objectFit: "cover" }} />
            <div style={{ flex: 1 }}>
              <strong>{photo.isPrimary ? "Primary" : `Photo ${index + 1}`}</strong>
              <label>Alt text<input aria-label={`Alt text for ${photo.filename}`} value={altDrafts[photo.id] ?? ""} onChange={(event) => setAltDrafts((current) => ({ ...current, [photo.id]: event.target.value }))} disabled={busyPhotoId !== null} /></label>
              <button onClick={() => saveAltText(photo.id)} disabled={busyPhotoId !== null || (altDrafts[photo.id] ?? "") === (photo.altText ?? "")}>Save alt text</button>
              <small>{photo.width}×{photo.height} · {photo.mimeType}</small>
            </div>
            <button aria-label={`Move ${photo.filename} earlier`} onClick={() => move(photo.id, -1)} disabled={busyPhotoId !== null || index === 0}>↑</button>
            <button aria-label={`Move ${photo.filename} later`} onClick={() => move(photo.id, 1)} disabled={busyPhotoId !== null || index === product.photos.length - 1}>↓</button>
            <button onClick={() => setPrimary(photo.id)} disabled={busyPhotoId !== null || photo.isPrimary}>Set primary</button>
            <button onClick={() => remove(photo.id)} disabled={busyPhotoId !== null}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
