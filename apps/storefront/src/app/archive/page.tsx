"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, resolveApiAssetUrl } from "@/lib/api";
import type { PaginatedResult, PublicProduct } from "@/lib/types";

const PAGE_SIZE = 12;

function storyExcerpt(product: PublicProduct): string | undefined {
  const text = product.productStory || product.description;
  if (!text) return undefined;
  return text.length > 140 ? `${text.slice(0, 140).trim()}…` : text;
}

export default function ArchivePage() {
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<PaginatedResult<PublicProduct>>(
        `/api/public/products/archive?page=${page}&pageSize=${PAGE_SIZE}`,
      )
      .then((res) => {
        setProducts(res.items);
        setTotal(res.total);
      })
      .catch(() => setError("Something went wrong loading the archive. Please try again."))
      .finally(() => setLoading(false));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="sf-archive">
      <h1>Archive / Sold Gallery</h1>
      <p style={{ color: "var(--noctella-aged-bronze)", maxWidth: 560 }}>
        A record of objects that have found their next home.
      </p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {loading && (
        <p role="status" style={{ color: "var(--noctella-aged-bronze)", textAlign: "center", padding: "40px 0" }}>
          Loading...
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#c86a6a", textAlign: "center", padding: "40px 0" }}>
          {error}
        </p>
      )}
      {!loading && !error && products.length === 0 && (
        <p style={{ color: "var(--noctella-aged-bronze)", textAlign: "center", padding: "40px 0" }}>
          The archive is empty for now.
        </p>
      )}

      {!loading && !error && products.length > 0 && (
        <div className="sf-archive__grid">
          {products.map((product) => {
            const primaryImage = product.images.find((img) => img.isPrimary) ?? product.images[0];
            const excerpt = storyExcerpt(product);
            return (
              <Link
                key={product.id}
                href={`/product/${product.slug}`}
                className="noctella-panel sf-archive__card"
              >
                <div className="sf-archive__image">
                  {primaryImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={resolveApiAssetUrl(primaryImage.url)}
                      alt={primaryImage.altText || product.title}
                    />
                  ) : (
                    <div style={{ width: "100%", height: "100%" }} />
                  )}
                  <span
                    style={{
                      position: "absolute",
                      top: 8,
                      left: 8,
                      fontSize: 10,
                      padding: "3px 8px",
                      borderRadius: 3,
                      background: "var(--noctella-aged-bronze)",
                      color: "var(--noctella-night-navy)",
                      fontWeight: 600,
                      letterSpacing: "0.03em",
                    }}
                  >
                    Sold
                  </span>
                </div>
                <div style={{ padding: 14 }}>
                  {product.categoryName && (
                    <p style={{ margin: 0, fontSize: 11, color: "var(--noctella-aged-bronze)", textTransform: "uppercase" }}>
                      {product.categoryName}
                      {product.period ? ` · ${product.period}` : ""}
                    </p>
                  )}
                  <h3 style={{ margin: "4px 0", fontSize: 16 }}>{product.title}</h3>
                  {excerpt && (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>{excerpt}</p>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {!loading && !error && products.length > 0 && (
        <div className="sf-archive__pagination">
          <span style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
            Page {page} of {totalPages} ({total} items)
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={buttonStyle}
            >
              Previous
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              style={buttonStyle}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 14px",
  fontSize: 13,
  cursor: "pointer",
};
