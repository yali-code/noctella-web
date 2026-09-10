"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CategoryDiscovery } from "@/components/CategoryDiscovery";
import { CommerceTrustStrip } from "@/components/CommerceTrustStrip";
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
  const [newestLoading, setNewestLoading] = useState(true);
  const [newestError, setNewestError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?sort=newest&pageSize=8"),
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?isFeatured=true&pageSize=8"),
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?collectionSlug=curators-pick&pageSize=8"),
      api.get<{ items: PublicCategory[] }>("/api/public/categories"),
    ]).then(([newestResult, featuredResult, curatorResult, categoryResult]) => {
      if (!active) return;
      if (newestResult.status === "fulfilled") setNewest(newestResult.value.items);
      else setNewestError("New arrivals could not be loaded. Please try again shortly.");
      if (featuredResult.status === "fulfilled") setFeatured(featuredResult.value.items);
      if (curatorResult.status === "fulfilled") setCuratorPicks(curatorResult.value.items);
      if (categoryResult.status === "fulfilled") setCategories(categoryResult.value.items);
      setNewestLoading(false);
    });
    return () => { active = false; };
  }, []);

  const newArrivals = newest.slice(0, NEW_ARRIVAL_COUNT);

  return (
    <div className="sf-home">
      <section className="sf-home-intro" aria-labelledby="home-heading">
        <p className="sf-eyebrow">Vintage &amp; collectible objects</p>
        <h1 id="home-heading">Find an object with a story.</h1>
        <p>Browse one-of-a-kind pieces selected for their character, craft, and history.</p>
        <SearchForm />
      </section>

      <HomeSection title="Categories" className="sf-home-section--categories">
        <CategoryDiscovery categories={categories} />
      </HomeSection>

      <HomeSection title="New Arrivals" viewAllHref="/shop">
        <ProductGrid products={newArrivals} loading={newestLoading} error={newestError} emptyMessage="No new arrivals are available yet." />
        {!newestLoading && !newestError && newArrivals.length === 0 && <Link className="sf-home-empty-link" href="/shop">Browse the shop</Link>}
      </HomeSection>

      {!newestLoading && featured.length > 0 && <HomeSection title="Featured Objects" viewAllHref="/shop">
        <ProductGrid products={featured} loading={false} error={null} />
      </HomeSection>}

      {!newestLoading && curatorPicks.length > 0 && <HomeSection title="Curator's Pick">
        <ProductGrid products={curatorPicks} loading={false} error={null} />
      </HomeSection>}

      <CommerceTrustStrip />

      <HomeSection title="Every Object Has a Story" className="sf-story">
        <p>Each piece in the Noctella collection carries a history. We preserve what time has touched and give it a place in someone&apos;s story once again.</p>
      </HomeSection>
    </div>
  );
}
