"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { ProductGallery } from "@/components/ProductGallery";
import { ProductCard } from "@/components/ProductCard";
import { MakeOfferForm } from "@/components/MakeOfferForm";
import { getWishlistIds, toggleWishlistPersisted } from "@/lib/wishlist";
import { addToCartPersisted, cartHasItem, getCart } from "@/lib/cart";
import type { PublicProductDetail } from "@/lib/types";

/**
 * Sprint 73: this is the pre-existing client implementation, unchanged, extracted from
 * page.tsx so the sibling Server Component page.tsx can export generateMetadata and render
 * Product JSON-LD. It still performs its own independent client-side fetch of the product for
 * interactivity (wishlist/cart/gallery) - deliberately not fed the server-fetched product as a
 * prop this sprint (see Sprint 73 approved architecture decisions).
 */
export function ProductDetailClient({ slug }: { slug: string }) {
  const [product, setProduct] = useState<PublicProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inWishlist, setInWishlist] = useState(false);
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [inCart, setInCart] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  useEffect(() => {
    api
      .get<PublicProductDetail>(`/api/public/products/${slug}`)
      .then((p) => {
        setProduct(p);
        setInWishlist(getWishlistIds().includes(p.id));
        setInCart(cartHasItem(getCart(), p.id));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError("Something went wrong loading this product. Please try again.");
      });
  }, [slug]);

  function handleToggleWishlist() {
    if (!product) return;
    const updated = toggleWishlistPersisted(product.id);
    setInWishlist(updated.includes(product.id));
    window.dispatchEvent(new Event("noctella:wishlist-updated"));
  }

  function handleAddToCart() {
    if (!product || product.status !== "published" || inCart) return;
    const primaryImage = product.images.find((img) => img.isPrimary) ?? product.images[0];
    addToCartPersisted({
      productId: product.id,
      slug: product.slug,
      title: product.title,
      primaryImageUrl: primaryImage?.url,
      eurPrice: product.priceEur,
      usdPrice: product.priceUsd,
      quantity: 1,
      productType: product.type,
      allowCashOnDelivery: product.allowCashOnDelivery,
    });
    setInCart(true);
    setJustAdded(true);
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }

  if (notFound) {
    return (
      <section style={{ padding: "60px 40px", textAlign: "center" }}>
        <h1>This item may have been sold or is no longer available</h1>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>
          It may have found its next home, or the link may be out of date.
        </p>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 16 }}>
          <Link href="/archive" style={{ fontSize: 14 }}>
            Browse the Archive
          </Link>
          <Link href="/shop" style={{ fontSize: 14 }}>
            Return to Shop
          </Link>
        </div>
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
  const productFacts = [
    ["Product type", formatProductType(product.type)],
    product.categoryName ? ["Category", product.categoryName] : null,
    product.collectionName ? ["Collection", product.collectionName] : null,
    product.brand ? ["Brand", product.brand] : null,
    product.model ? ["Model", product.model] : null,
    product.manufacturer ? ["Manufacturer", product.manufacturer] : null,
    product.countryOfOrigin ? ["Country of origin", product.countryOfOrigin] : null,
    product.period ? ["Period", product.period] : null,
    product.materials ? ["Materials", product.materials] : null,
    dimensions ? ["Dimensions", `${dimensions}${product.dimensionUnit ? ` ${product.dimensionUnit}` : ""}`] : null,
    product.weightValue !== undefined
      ? ["Weight", `${product.weightValue}${product.weightUnit ? ` ${product.weightUnit}` : ""}`]
      : null,
  ].filter((fact): fact is string[] => fact !== null);

  return (
    <section className="sf-pdp">
      <div className="sf-pdp__layout">
        <div className="sf-pdp__media">
          <ProductGallery images={product.images} title={product.title} />
          {product.videoUrl && (
            <p style={{ marginTop: 12 }}>
              <a href={product.videoUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>
                Watch video
              </a>
            </p>
          )}
        </div>

        <div className="sf-pdp__content">
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
          <h1>{product.title}</h1>
          <p className="sf-pdp__price">
            €{product.priceEur.toFixed(2)}
            {product.priceUsd !== undefined && (
              <span style={{ fontSize: 14, color: "var(--noctella-aged-bronze)", marginLeft: 10 }}>
                (${product.priceUsd.toFixed(2)})
              </span>
            )}
          </p>
          {product.shortDescription && (
            <p className="sf-pdp__summary">{product.shortDescription}</p>
          )}

          {product.condition && (
            <div className="sf-pdp__condition" aria-label="Cosmetic condition">
              <span>Cosmetic condition</span>
              <strong>{product.condition}</strong>
            </div>
          )}

          <div className="sf-pdp__actions">
            <button onClick={handleToggleWishlist} className="sf-pdp__button sf-pdp__button--secondary" aria-pressed={inWishlist}>
              {inWishlist ? "Remove from Wishlist" : "Add to Wishlist"}
            </button>
            {product.allowMakeOffer && (
              <button onClick={() => setShowOfferForm((v) => !v)} className="sf-pdp__button sf-pdp__button--primary">
                Make an Offer
              </button>
            )}
            <button disabled className="sf-pdp__button sf-pdp__button--disabled" title="Coming soon">
              Ask AI
            </button>
            <button
              onClick={handleAddToCart}
              disabled={product.status !== "published" || inCart}
              className={`sf-pdp__button ${inCart ? "sf-pdp__button--secondary" : "sf-pdp__button--primary"}`}
              aria-live="polite"
            >
              {inCart ? (justAdded ? "Added to Cart" : "Already in Cart") : "Add to Cart"}
            </button>
          </div>

          {inCart && (
            <p style={{ fontSize: 13, color: "var(--noctella-bright-star-gold)", marginTop: -12 }}>
              <Link href="/cart" style={{ color: "inherit" }}>
                View Cart
              </Link>
            </p>
          )}

          {showOfferForm && product.allowMakeOffer && (
            <div style={{ marginBottom: 20 }}>
              <MakeOfferForm productId={product.id} productTitle={product.title} />
            </div>
          )}

          {product.conditionDescription && (
            <section className="sf-pdp__section" aria-labelledby="condition-details-heading">
              <h2 id="condition-details-heading">Condition details</h2>
              <p>{product.conditionDescription}</p>
            </section>
          )}

          <section className="sf-pdp__section" aria-labelledby="product-facts-heading">
            <h2 id="product-facts-heading">Product facts</h2>
            <dl className="sf-pdp__facts">
              {productFacts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {product.description && (
            <>
              <h2 className="sf-pdp__section-heading">Description</h2>
              <p className="sf-pdp__prose">{product.description}</p>
            </>
          )}

          {product.productStory && (
            <>
              <h2 className="sf-pdp__section-heading">Story</h2>
              <p className="sf-pdp__prose">{product.productStory}</p>
            </>
          )}

          {(product.shippingNote || product.customsWarning) && (
            <div style={{ marginTop: 20 }}>
              <h2 className="sf-pdp__section-heading">Shipping</h2>
              {product.shippingNote && <p className="sf-pdp__prose">{product.shippingNote}</p>}
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

function formatProductType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
