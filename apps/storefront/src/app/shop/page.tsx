"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ProductGrid } from "@/components/ProductGrid";
import type { PaginatedResult, PublicCategory, PublicCollection, PublicProduct } from "@/lib/types";

const PAGE_SIZE = 12;

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "title_asc", label: "Title: A–Z" },
];

export default function ShopPage() {
  return (
    <Suspense
      fallback={
        <section style={{ padding: "48px 40px" }}>
          <p role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
            Loading...
          </p>
        </section>
      }
    >
      <ShopPageContent />
    </Suspense>
  );
}

function ShopPageContent() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get("search") ?? "";

  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(initialSearch);
  const [categorySlug, setCategorySlug] = useState("");
  const [collectionSlug, setCollectionSlug] = useState("");
  const [sort, setSort] = useState("newest");
  const [categories, setCategories] = useState<PublicCategory[]>([]);
  const [collections, setCollections] = useState<PublicCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: PublicCategory[] }>("/api/public/categories")
      .then((res) => setCategories(res.items))
      .catch(() => {});
    api
      .get<{ items: PublicCollection[] }>("/api/public/collections")
      .then((res) => setCollections(res.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort });
    if (search) params.set("search", search);
    if (categorySlug) params.set("categorySlug", categorySlug);
    if (collectionSlug) params.set("collectionSlug", collectionSlug);

    api
      .get<PaginatedResult<PublicProduct>>(`/api/public/products?${params.toString()}`)
      .then((res) => {
        setProducts(res.items);
        setTotal(res.total);
      })
      .catch(() => setError("Something went wrong loading products. Please try again."))
      .finally(() => setLoading(false));
  }, [page, search, categorySlug, collectionSlug, sort]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>Shop</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 4 }}>
          Search
          <input
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            style={inputStyle}
            placeholder="Search products"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 4 }}>
          Category
          <select
            value={categorySlug}
            onChange={(e) => {
              setPage(1);
              setCategorySlug(e.target.value);
            }}
            style={inputStyle}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 4 }}>
          Collection
          <select
            value={collectionSlug}
            onChange={(e) => {
              setPage(1);
              setCollectionSlug(e.target.value);
            }}
            style={inputStyle}
          >
            <option value="">All collections</option>
            {collections.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 4 }}>
          Sort by
          <select
            value={sort}
            onChange={(e) => {
              setPage(1);
              setSort(e.target.value);
            }}
            style={inputStyle}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ProductGrid products={products} loading={loading} error={error} emptyMessage="No products match your search." />

      {!loading && !error && products.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 28 }}>
          <span style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
            Page {page} of {totalPages} ({total} items)
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={buttonStyle}>
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

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
  minWidth: 160,
};

const buttonStyle: React.CSSProperties = {
  ...inputStyle,
  minWidth: 0,
  cursor: "pointer",
};
