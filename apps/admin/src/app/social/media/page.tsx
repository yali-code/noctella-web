"use client";
import Link from "next/link";
import { useState } from "react";
import { ProductMediaPicker } from "../ProductMediaPicker";
export default function SocialMediaPool() {
  const [productId, setProductId] = useState<string | null>(null);
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  return <section><h2>Media Pool</h2><p>Browse canonical product photos and select media for a content draft.</p>
    <ProductMediaPicker productId={productId} mediaIds={mediaIds} onChange={(product, media) => { setProductId(product); setMediaIds(media); }} />
    {productId && mediaIds.length > 0 && <Link href={`/social/new?${new URLSearchParams({ product: productId, media: mediaIds.join(",") })}`}>Create draft with selected media</Link>}
  </section>;
}
