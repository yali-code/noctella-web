"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { ProductGallery } from "@/components/ProductGallery";
import { ProductCard } from "@/components/ProductCard";
import { MakeOfferForm } from "@/components/MakeOfferForm";
import { getWishlistIds, toggleWishlistPersisted } from "@/lib/wishlist";
import type { PublicProductDetail } from "@/lib/types";

export default function ProductDetailPage({ params }: { params: { slug: string } }) {
  const [product, setProduct] = useState<PublicProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inWishlist, setInWishlist] = useState(false);
  const [showOfferForm, setShowOfferForm] = useState(false);

  useEffect(() => {
    api
      .get<PublicProductDetail>(`/api/public/products/${params.slug}`)
      .then((p) => {
        setProduct(p);
        setInWishlist(getWishlistIds().includes(p.id));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError("Something went wrong loading this product. Please try again.");
      });
  }, [params.slug]);

  function handleToggleWishlist() {
    if (!product) return;
    const updated = toggleWishlistPersisted(product.id);
    setInWishlist(updated.includes(product.id));
    window.dispatchEvent(new Event("noctella:wishlist-updated"));
  }

  if (notFound) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <h1>Product not found</h1>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>
          This item may no longer be available. <Link href="/shop">Return to Shop</Link>
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <p role="alert" style={{ color: "#c86a6a" }}>
          {error}
        </p>
      </section>
    );
  }

  if (!product) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <p role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
          Loading...
        </p>
      </section>
    );
  }

  const dimensions = [product.lengthValue, product.widthValue, product.heightValue]
    .filter((v) => v !== undefined)
    .join(" × ");

  return (
    <section style={{ padding: "48px 40px" }}>
      <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 380px", maxWidth: 480 }}>
          <ProductGallery images={product.images} title={product.title} />
          {product.videoUrl && (
            <p style={{ marginTop: 12 }}>
              <a href={product.videoUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>
                Watch video
              </a>
            </p>
          )}
        </div>

        <div style={{ flex: "1 1 380px" }}>
          {product.isFeatured && (
            <span
              style={{
                display: "inline-block",
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 3,
                background: "var(--noctella-antique-gold)",
                color: "var(--noctella-night-navy)",
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Featured
            </span>
          )}
          <h1 style={{ marginTop: 0 }}>{product.title}</h1>
          <p style={{ fontSize: 22, margin: "8px 0" }}>
            €{product.priceEur.toFixed(2)}
            {product.priceUsd !== undefined && (
              <span style={{ fontSize: 14, color: "var(--noctella-aged-bronze)", marginLeft: 10 }}>
                (${product.priceUsd.toFixed(2)})
              </span>
            )}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, margin: "16px 0" }}>
            <Row label="Product Type" value={formatProductType(product.type)} />
            {product.categoryName && <Row label="Category" value={product.categoryName} />}
            {product.collectionName && <Row label="Collection" value={product.collectionName} />}
            {product.brand && <Row label="Brand" value={product.brand} />}
            {product.model && <Row label="Model" value={product.model} />}
            {product.manufacturer && <Row label="Manufacturer" value={product.manufacturer} />}
            {product.countryOfOrigin && <Row label="Country of Origin" value={product.countryOfOrigin} />}
            {product.period && <Row label="Period" value={product.period} />}
            {product.materials && <Row label="Materials" value={product.materials} />}
            {dimensions && (
              <Row label="Dimensions" value={`${dimensions}${product.dimensionUnit ? ` ${product.dimensionUnit}` : ""}`} />
            )}
            {product.weightValue !== undefined && (
              <Row label="Weight" value={`${product.weightValue}${product.weightUnit ? ` ${product.weightUnit}` : ""}`} />
            )}
            {product.condition && <Row label="Condition" value={product.condition} />}
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "20px 0" }}>
            <button onClick={handleToggleWishlist} style={secondaryButtonStyle} aria-pressed={inWishlist}>
              {inWishlist ? "Remove from Wishlist" : "Add to Wishlist"}
            </button>
            {product.allowMakeOffer && (
              <button onClick={() => setShowOfferForm((v) => !v)} style={primaryButtonStyle}>
                Make an Offer
              </button>
            )}
            <button disabled style={disabledButtonStyle} title="Coming soon">
              Ask AI
            </button>
            <button disabled style={disabledButtonStyle} title="Coming soon">
              Add to Cart
            </button>
          </div>

          {showOfferForm && product.allowMakeOffer && (
            <div style={{ marginBottom: 20 }}>
              <MakeOfferForm productId={product.id} productTitle={product.title} />
            </div>
          )}

          {product.conditionDescription && (
            <>
              <h2 style={{ fontSize: 16 }}>Condition</h2>
              <p style={{ color: "var(--noctella-ivory)" }}>{product.conditionDescription}</p>
            </>
          )}

          {product.description && (
            <>
              <h2 style={{ fontSize: 16 }}>Description</h2>
              <p style={{ color: "var(--noctella-ivory)" }}>{product.description}</p>
            </>
          )}

          {product.productStory && (
            <>
              <h2 style={{ fontSize: 16 }}>Story</h2>
              <p style={{ color: "var(--noctella-ivory)" }}>{product.productStory}</p>
            </>
          )}

          {(product.shippingNote || product.customsWarning) && (
            <div style={{ marginTop: 20 }}>
              <h2 style={{ fontSize: 16 }}>Shipping</h2>
              {product.shippingNote && <p style={{ color: "var(--noctella-ivory)" }}>{product.shippingNote}</p>}
              {product.customsWarning && (
                <p style={{ color: "var(--noctella-aged-bronze)", fontSize: 13 }}>
                  Buyer is responsible for customs duties and import taxes.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {product.relatedProducts.length > 0 && (
        <div style={{ marginTop: 56 }}>
          <h2>Related Objects</h2>
          <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 20,
            }}
          >
            {product.relatedProducts.map((related) => (
              <ProductCard key={related.id} product={related} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <span style={{ color: "var(--noctella-aged-bronze)", minWidth: 140 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function formatProductType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  fontSize: 14,
  cursor: "pointer",
};

const disabledButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};
