"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ProductGrid } from "@/components/ProductGrid";
import { taxonomyBrowseHref } from "@/lib/taxonomyBrowseParams";
import type { PaginatedResult, PublicCategory, PublicProduct } from "@/lib/types";

const PAGE_SIZE = 12;

/** Client-side taxonomy and catalog loading; the Server Component owns page normalization. */
export function CategoryPageClient({ slug, page }: { slug: string; page: number }) {
  const router = useRouter();
  const [category, setCategory] = useState<PublicCategory | null>(null);
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [resolvedTaxonomySlug, setResolvedTaxonomySlug] = useState<string | null>(null);
  const [resolvedProductsKey, setResolvedProductsKey] = useState<string | null>(null);
  const productsKey = JSON.stringify([slug, page]);

  useEffect(() => {
    let active = true;
    setCategory(null);
    setNotFound(false);
    setResolvedTaxonomySlug(null);
    api
      .get<PublicCategory>(`/api/public/categories/${slug}`)
      .then((nextCategory) => {
        if (!active) return;
        setCategory(nextCategory);
        setResolvedTaxonomySlug(slug);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        setResolvedTaxonomySlug(slug);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setProducts([]);
    setTotal(0);
    setResolvedProductsKey(null);
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      categorySlug: slug,
    });
    api
      .get<PaginatedResult<PublicProduct>>(`/api/public/products?${query.toString()}`)
      .then((res) => {
        if (!active) return;
        const lastPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
        if (page > lastPage) {
          router.replace(taxonomyBrowseHref("category", slug, lastPage));
          return;
        }
        setProducts(res.items);
        setTotal(res.total);
        setResolvedProductsKey(productsKey);
      })
      .catch(() => {
        if (!active) return;
        setError("Something went wrong loading products. Please try again.");
        setResolvedProductsKey(productsKey);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, productsKey, router, slug]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const taxonomyIsCurrent = resolvedTaxonomySlug === slug;
  const productsAreCurrent = resolvedProductsKey === productsKey;
  const productsLoading = loading || !productsAreCurrent;

  if (taxonomyIsCurrent && notFound) {
    return (
      <section style={{ padding: "60px 40px" }}>
        <h1>Category not found</h1>
      </section>
    );
  }

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>{taxonomyIsCurrent ? category?.name ?? "Category" : "Category"}</h1>
      {taxonomyIsCurrent && category?.description && (
        <p style={{ color: "var(--noctella-aged-bronze)", maxWidth: 640 }}>{category.description}</p>
      )}
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <ProductGrid
        products={productsAreCurrent ? products : []}
        loading={productsLoading}
        error={productsAreCurrent ? error : null}
        emptyMessage="No products in this category yet."
      />

      {!productsLoading && !error && products.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 28 }}>
          <span style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
            Page {page} of {totalPages} ({total} items)
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={page <= 1}
              onClick={() => router.push(taxonomyBrowseHref("category", slug, Math.max(1, page - 1)))}
              style={buttonStyle}
            >
              Previous
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => router.push(taxonomyBrowseHref("category", slug, Math.min(totalPages, page + 1)))}
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
