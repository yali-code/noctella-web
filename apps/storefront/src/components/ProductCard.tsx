"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { resolveApiAssetUrl } from "@/lib/api";
import { primaryProductImage, productThumbnailUrl } from "@/lib/productImages";
import type { PublicProduct } from "@/lib/types";
import { getWishlistIds, toggleWishlistPersisted } from "@/lib/wishlist";

export function ProductCard({ product }: { product: PublicProduct }) {
  const primaryImage = primaryProductImage(product);
  const [wishlisted, setWishlisted] = useState(false);

  useEffect(() => setWishlisted(getWishlistIds().includes(product.id)), [product.id]);

  function toggleWishlist() {
    const updated = toggleWishlistPersisted(product.id);
    setWishlisted(updated.includes(product.id));
    window.dispatchEvent(new Event("noctella:wishlist-updated"));
  }

  return (
    <article className="sf-product-card">
      <Link href={`/product/${product.slug}`} className="sf-product-card__link" aria-label={`View ${product.title}`}>
        <div className="sf-product-card__image">
          {primaryImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={resolveApiAssetUrl(productThumbnailUrl(primaryImage))} alt={primaryImage.altText || product.title}
              width={800} height={1000} loading="lazy" decoding="async" />
          ) : <span role="img" aria-label={`${product.title}: image unavailable`}>Image unavailable</span>}
          <div className="sf-product-card__badges" aria-hidden="true">
            {product.isFeatured && <Badge label="Featured" />}
            {product.allowMakeOffer && <Badge label="Make Offer" />}
          </div>
        </div>
        <div className="sf-product-card__content">
          {product.condition && <p className="sf-product-card__condition">{product.condition}</p>}
          <h3>{product.title}</h3>
          <p className="sf-product-card__price">{formatPrice(product.priceEur)}</p>
        </div>
      </Link>
      <button type="button" className="sf-product-card__wishlist"
        aria-label={`${wishlisted ? "Remove" : "Add"} ${product.title} ${wishlisted ? "from" : "to"} wishlist`}
        aria-pressed={wishlisted} onClick={toggleWishlist}>
        <span aria-hidden="true">{wishlisted ? "♥" : "♡"}</span>
      </button>
    </article>
  );
}

function formatPrice(value: number) {
  return typeof value === "number" && Number.isFinite(value) ? `€${value.toFixed(2)}` : "Price unavailable";
}

function Badge({ label }: { label: string }) {
  return <span className="sf-product-card__badge">{label}</span>;
}
