"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ProductGrid } from "@/components/ProductGrid";
import {
  parseShopSearchParams,
  shopHref,
  withShopBrowseChange,
  type ShopBrowseState,
  type ShopSort,
} from "@/lib/shopSearchParams";
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const browse = useMemo(() => parseShopSearchParams(new URLSearchParams(queryString)), [queryString]);

  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [searchDraft, setSearchDraft] = useState(browse.search);
  const [categories, setCategories] = useState<PublicCategory[]>([]);
  const [collections, setCollections] = useState<PublicCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSearchDraft(browse.search);
  }, [browse.search]);

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
    const params = new URLSearchParams({ page: String(browse.page), pageSize: String(PAGE_SIZE), sort: browse.sort });
    if (browse.search) params.set("search", browse.search);
    if (browse.category) params.set("categorySlug", browse.category);
    if (browse.collection) params.set("collectionSlug", browse.collection);

    api
      .get<PaginatedResult<PublicProduct>>(`/api/public/products?${params.toString()}`)
      .then((res) => {
        setProducts(res.items);
        setTotal(res.total);
      })
      .catch(() => setError("Something went wrong loading products. Please try again."))
      .finally(() => setLoading(false));
  }, [browse.category, browse.collection, browse.page, browse.search, browse.sort]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function navigate(next: ShopBrowseState) {
    router.push(shopHref(next));
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    navigate(withShopBrowseChange(browse, { search: searchDraft.trim() }));
  }

  return (
    <section className="sf-shop">
      <h1>Shop</h1>
      <p className="sf-shop__intro">Browse vintage and collectible objects available from Noctella.</p>

      <form className="sf-shop-controls" role="search" onSubmit={submitSearch}>
        <label className="sf-shop-control sf-shop-control--search">
          <span>Search</span>
          <input
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search products"
          />
        </label>
        <button type="submit" className="sf-shop-button sf-shop-button--primary">Search</button>
        <label className="sf-shop-control">
          <span>Category</span>
          <select
            value={browse.category}
            onChange={(event) => navigate(withShopBrowseChange(browse, { category: event.target.value }))}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="sf-shop-control">
          <span>Collection</span>
          <select
            value={browse.collection}
            onChange={(event) => navigate(withShopBrowseChange(browse, { collection: event.target.value }))}
          >
            <option value="">All collections</option>
            {collections.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="sf-shop-control">
          <span>Sort by</span>
          <select
            value={browse.sort}
            onChange={(event) => navigate(withShopBrowseChange(browse, { sort: event.target.value as ShopSort }))}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="sf-shop-button" onClick={() => router.push("/shop")}>Reset filters</button>
      </form>

      <ProductGrid products={products} loading={loading} error={error} emptyMessage="No products match your search." />

      {!loading && !error && products.length > 0 && (
        <nav className="sf-shop-pagination" aria-label="Product pagination">
          <span>
            Page {browse.page} of {totalPages} ({total} items)
          </span>
          <div>
            <button className="sf-shop-button" disabled={browse.page <= 1} onClick={() => navigate({ ...browse, page: Math.max(1, browse.page - 1) })}>
              Previous
            </button>
            <button
              className="sf-shop-button"
              disabled={browse.page >= totalPages}
              onClick={() => navigate({ ...browse, page: Math.min(totalPages, browse.page + 1) })}
            >
              Next
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
