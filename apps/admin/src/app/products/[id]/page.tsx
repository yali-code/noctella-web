"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ProductDetail } from "@/lib/types";

export default function ProductViewPage({ params }: { params: { id: string } }) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    api
      .get<ProductDetail>(`/api/products/${params.id}`)
      .then(setProduct)
      .catch((err) => setError(err.message ?? "Failed to load product"));
  }, [params.id]);

  async function handleArchive() {
    if (!product) return;
    setArchiving(true);
    try {
      const updated = await api.post<ProductDetail>(`/api/products/${product.id}/archive`, {});
      setProduct(updated);
    } finally {
      setArchiving(false);
    }
  }

  if (error) return <p style={{ color: "#c86a6a" }}>{error}</p>;
  if (!product) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading...</p>;

  const primaryImage = product.images.find((img) => img.isPrimary) ?? product.images[0];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{product.title}</h1>
        <div style={{ display: "flex", gap: 12 }}>
          <Link
            href={`/products/${product.id}/publishing`}
            className="noctella-panel"
            style={{ padding: "10px 18px", fontSize: 14, color: "var(--noctella-bright-star-gold)" }}
          >
            Publishing
          </Link>
          <Link
            href={`/products/${product.id}/photos`}
            className="noctella-panel"
            style={{ padding: "10px 18px", fontSize: 14, color: "var(--noctella-bright-star-gold)" }}
          >
            Photos
          </Link>
          <button
            onClick={handleArchive}
            disabled={archiving || product.status === "archived"}
            style={{
              padding: "10px 18px",
              fontSize: 14,
              background: "transparent",
              border: "1px solid var(--noctella-aged-bronze)",
              color: "var(--noctella-ivory)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            {product.status === "archived" ? "Archived" : archiving ? "Archiving..." : "Archive"}
          </button>
        </div>
      </div>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 32 }}>
        {primaryImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={primaryImage.url}
            alt={primaryImage.altText ?? ""}
            style={{ width: 220, height: 220, objectFit: "cover", borderRadius: 4, border: "1px solid var(--noctella-antique-gold)" }}
          />
        )}
        <div className="noctella-panel" style={{ padding: 20, flex: 1 }}>
          <Row label="SKU" value={product.sku} />
          <Row label="Slug" value={product.slug} />
          <Row label="Type" value={product.type} />
          <Row label="Status" value={product.status} />
          <Row label="EUR Price" value={`€${product.priceEur.toFixed(2)}`} />
          {product.priceUsd && <Row label="USD Price" value={`$${product.priceUsd.toFixed(2)}`} />}
          <Row label="Stock Quantity" value={String(product.stockQuantity)} />
          {product.lotItemCount !== undefined && <Row label="Lot Item Count" value={String(product.lotItemCount)} />}
          {product.brand && <Row label="Brand" value={product.brand} />}
          {product.condition && <Row label="Condition" value={product.condition} />}
          <Row label="Updated" value={new Date(product.updatedAt).toLocaleString()} />
        </div>
      </div>

      {product.description && (
        <div style={{ marginTop: 24 }}>
          <h3>Description</h3>
          <p style={{ color: "var(--noctella-ivory)" }}>{product.description}</p>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <h3>Marketplace Readiness</h3>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ReadinessCard label="eBay" readiness={product.marketplaceReadiness.ebay} />
          <ReadinessCard label="Etsy" readiness={product.marketplaceReadiness.etsy} />
          <ReadinessCard label="WooCommerce" readiness={product.marketplaceReadiness.woocommerce} />
        </div>
      </div>
    </div>
  );
}

function ReadinessCard({
  label,
  readiness,
}: {
  label: string;
  readiness: { ready: boolean; missingFields: string[] };
}) {
  return (
    <div className="noctella-panel" style={{ padding: 16, minWidth: 200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 14 }}>{label}</span>
        <span
          style={{
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 4,
            color: readiness.ready ? "var(--noctella-night-navy)" : "var(--noctella-ivory)",
            background: readiness.ready ? "var(--noctella-bright-star-gold)" : "transparent",
            border: readiness.ready ? "none" : "1px solid var(--noctella-aged-bronze)",
          }}
        >
          {readiness.ready ? "Ready" : "Not Ready"}
        </span>
      </div>
      {!readiness.ready && (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--noctella-aged-bronze)" }}>
          Missing: {readiness.missingFields.join(", ")}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
