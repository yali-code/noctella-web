"use client";

import { useEffect, useMemo, useState } from "react";
import { CategoryDiscovery } from "@/components/CategoryDiscovery";
import { HomeSection } from "@/components/HomeSection";
import { ProductGrid } from "@/components/ProductGrid";
import { SearchForm } from "@/components/SearchForm";
import { api } from "@/lib/api";
import type { PaginatedResult, PublicCategory, PublicProduct } from "@/lib/types";

const NEW_ARRIVAL_COUNT = 8;

export function HomeClient() {
  const [newest, setNewest] = useState<PublicProduct[]>([]);
  const [featured, setFeatured] = useState<PublicProduct[]>([]);
  const [curatorPicks, setCuratorPicks] = useState<PublicProduct[]>([]);
  const [categories, setCategories] = useState<PublicCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?sort=newest&pageSize=24"),
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?isFeatured=true&pageSize=8"),
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?collectionSlug=curators-pick&pageSize=8"),
      api.get<{ items: PublicCategory[] }>("/api/public/categories"),
    ]).then(([newestResult, featuredResult, curatorResult, categoryResult]) => {
      if (!active) return;
      if (newestResult.status === "fulfilled") setNewest(newestResult.value.items);
      else setError("Some objects could not be loaded. Please try again shortly.");
      if (featuredResult.status === "fulfilled") setFeatured(featuredResult.value.items);
      if (curatorResult.status === "fulfilled") setCuratorPicks(curatorResult.value.items);
      if (categoryResult.status === "fulfilled") setCategories(categoryResult.value.items);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const newArrivals = newest.slice(0, NEW_ARRIVAL_COUNT);
  const continuation = useMemo(() => {
    const used = new Set([...featured, ...curatorPicks, ...newArrivals].map((product) => product.id));
    return newest.slice(NEW_ARRIVAL_COUNT).filter((product) => !used.has(product.id)).slice(0, 8);
  }, [featured, curatorPicks, newArrivals, newest]);

  return (
    <div className="sf-home">
      <section className="sf-home-intro" aria-labelledby="home-heading">
        <p className="sf-eyebrow">Noctella · Nova Vita ex Praeterito</p>
        <h1 id="home-heading">Vintage objects, chosen for a new life.</h1>
        <p>Premium vintage and collectible objects, curated with care.</p>
        <SearchForm />
      </section>

      <HomeSection title="Categories" className="sf-home-section--categories">
        <CategoryDiscovery categories={categories} />
      </HomeSection>

      {error && <p className="sf-home-error" role="alert">{error}</p>}
      {loading && <p className="sf-home-loading" role="status">Loading curated objects…</p>}

      {!loading && featured.length > 0 && <HomeSection title="Featured Objects" viewAllHref="/shop">
        <ProductGrid products={featured} loading={false} error={null} />
      </HomeSection>}

      {!loading && curatorPicks.length > 0 && <HomeSection title="Curator's Pick">
        <ProductGrid products={curatorPicks} loading={false} error={null} />
      </HomeSection>}

      {!loading && continuation.length > 0 && <HomeSection title="Explore the Collection" viewAllHref="/shop">
        <ProductGrid products={continuation} loading={false} error={null} />
      </HomeSection>}

      {!loading && newArrivals.length > 0 && <HomeSection title="New Arrivals" viewAllHref="/shop?sort=newest">
        <ProductGrid products={newArrivals} loading={false} error={null} />
      </HomeSection>}

      <HomeSection title="Every Object Has a Story" className="sf-story">
        <p>Each piece in the Noctella collection carries a history. We preserve what time has touched and give it a place in someone&apos;s story once again.</p>
      </HomeSection>
    </div>
  );
}
