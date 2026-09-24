"use client";
import { useEffect, useState } from "react";
import type { SocialMediaPhoto } from "@noctella/shared";
import { api, resolveApiAssetUrl } from "@/lib/api";
import { control, grid, panel } from "./styles";

interface Product { id: string; title: string; sku: string }
export function ProductMediaPicker({ productId, mediaIds, onChange }: {
  productId: string | null; mediaIds: string[]; onChange: (productId: string | null, mediaIds: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Product | null>(null);
  const [photos, setPhotos] = useState<SocialMediaPhoto[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setError("");
      api.get<{ items: Product[]; total: number }>(`/api/products?${new URLSearchParams({ search, page: String(page), pageSize: "12" })}`)
        .then((result) => { if (active) { setProducts(result.items); setTotal(result.total); } })
        .catch(() => { if (active) setError("Products could not be loaded."); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [search, page]);
  useEffect(() => {
    let active = true;
    setPhotos([]); setSelected(null); setError("");
    if (!productId) { setLoading(false); return; }
    setLoading(true);
    api.get<Product & { photos: Array<SocialMediaPhoto & { processingStatus?: string }> }>(`/api/products/${encodeURIComponent(productId)}`)
      .then((product) => { if (active) { setSelected(product); setPhotos((product.photos ?? []).filter((photo) => !photo.processingStatus || photo.processingStatus === "Ready")); } })
      .catch(() => { if (active) setError("Product media could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [productId]);
  return <section className="noctella-panel" style={panel}>
    <h3>Product and media</h3>
    {error && <p role="alert">{error}</p>}
    <label>Search products <input style={control} value={search} maxLength={200} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
    <ul>{products.map((product) => <li key={product.id} style={{ margin: "8px 0" }}>
      <button type="button" style={control} aria-pressed={productId === product.id} onClick={() => onChange(product.id, [])}>{product.sku} · {product.title}</button>
    </li>)}</ul>
    {!products.length && <p>No matching products.</p>}
    <button type="button" style={control} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous products</button>{" "}
    <button type="button" style={control} disabled={page * 12 >= total} onClick={() => setPage(page + 1)}>Next products</button>
    {selected ? <p>Selected product: {selected.sku} · {selected.title} <button type="button" style={control} onClick={() => onChange(null, [])}>Clear selection</button></p> : !productId && <p>No selected product/media.</p>}
    {loading ? <p role="status">Loading media…</p> : productId && !photos.length ? <p>No media available.</p> : null}
    <div style={grid}>{photos.map((photo) => <label key={photo.id} className="noctella-panel" style={{ padding: 12, outline: mediaIds.includes(photo.id) ? "2px solid var(--noctella-bright-star-gold)" : undefined }}>
      <img src={resolveApiAssetUrl(photo.thumbnailUrl || photo.url)} alt={photo.altText || selected?.title || "Product photo"} style={{ width: "100%", height: 150, objectFit: "contain" }} />
      <input type="checkbox" aria-label={`Select photo ${photo.id}`} checked={mediaIds.includes(photo.id)} disabled={!mediaIds.includes(photo.id) && mediaIds.length >= 10}
        onChange={() => onChange(productId, mediaIds.includes(photo.id) ? mediaIds.filter((id) => id !== photo.id) : [...mediaIds, photo.id])} /> Selected
    </label>)}</div>
    <p>{mediaIds.length} photos selected (maximum 10).</p>
  </section>;
}
