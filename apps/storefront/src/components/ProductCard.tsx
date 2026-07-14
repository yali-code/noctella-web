import Link from "next/link";
import { primaryProductImage, productThumbnailUrl } from "@/lib/productImages";
import type { PublicProduct } from "@/lib/types";

export function ProductCard({ product }: { product: PublicProduct }) {
  const primaryImage = primaryProductImage(product);

  return (
    <Link
      href={`/product/${product.slug}`}
      className="noctella-panel"
      style={{
        display: "block",
        textDecoration: "none",
        color: "var(--noctella-ivory)",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "relative", aspectRatio: "1 / 1", background: "var(--noctella-night-navy)" }}>
        {primaryImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={productThumbnailUrl(primaryImage)}
            alt={primaryImage.altText || product.title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%" }} />
        )}
        <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 6 }}>
          {product.isFeatured && <Badge label="Featured" />}
          {product.allowMakeOffer && <Badge label="Make Offer" />}
        </div>
      </div>
      <div style={{ padding: 14 }}>
        {product.categoryName && (
          <p style={{ margin: 0, fontSize: 11, color: "var(--noctella-aged-bronze)", textTransform: "uppercase" }}>
            {product.categoryName}
          </p>
        )}
        <h3 style={{ margin: "4px 0", fontSize: 16 }}>{product.title}</h3>
        <p style={{ margin: 0, fontSize: 14 }}>
          €{product.priceEur.toFixed(2)}
          {product.priceUsd !== undefined && (
            <span style={{ color: "var(--noctella-aged-bronze)", marginLeft: 8, fontSize: 12 }}>
              (${product.priceUsd.toFixed(2)})
            </span>
          )}
        </p>
      </div>
    </Link>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "3px 8px",
        borderRadius: 3,
        background: "var(--noctella-antique-gold)",
        color: "var(--noctella-night-navy)",
        fontWeight: 600,
        letterSpacing: "0.03em",
      }}
    >
      {label}
    </span>
  );
}
