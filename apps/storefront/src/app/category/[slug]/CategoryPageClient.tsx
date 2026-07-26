"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ProductGrid } from "@/components/ProductGrid";
import type { PaginatedResult, PublicCategory, PublicProduct } from "@/lib/types";

const PAGE_SIZE = 12;

/**
 * Sprint 73: pre-existing client implementation, unchanged, extracted from page.tsx so the
 * sibling Server Component page.tsx can export generateMetadata. Still performs its own
 * independent client-side fetch for the category entity and the product list/pagination -
 * list/filtering behavior is deliberately left entirely client-side this sprint.
 */
export function CategoryPageClient({ slug }: { slug: string }) {
  const [category, setCategory] = useState<PublicCategory | null>(null);
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api
      .get<PublicCategory>(`/api/public/categories/${slug}`)
      .then(setCategory)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
      });
  }, [slug]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      categorySlug: slug,
    });
    api
      .get<PaginatedResult<PublicProduct>>(`/api/public/products?${query.toString()}`)
      .then((res) => {
        setProducts(res.items);
        setTotal(res.total);
      })
      .catch(() => setError("Something went wrong loading products. Please try again."))
      .finally(() => setLoading(false));
  }, [slug, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (notFound) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <h1>Category not found</h1>
      </section>
    );
  }

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>{category?.name ?? "Category"}</h1>
      {category?.description && (
        <p style={{ color: "var(--noctella-aged-bronze)", maxWidth: 640 }}>{category.description}</p>
      )}
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <ProductGrid
        products={products}
        loading={loading}
        error={error}
        emptyMessage="No products in this category yet."
      />

      {!loading && !error && products.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 28 }}>
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
