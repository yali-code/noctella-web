"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ConstellationBackground } from "@/components/ConstellationBackground";
import { ProductCard } from "@/components/ProductCard";
import { api } from "@/lib/api";
import type { PaginatedResult, PublicCategory, PublicProduct } from "@/lib/types";

export default function HomePage() {
  const [newArrivals, setNewArrivals] = useState<PublicProduct[]>([]);
  const [featured, setFeatured] = useState<PublicProduct[]>([]);
  const [gentlemanSeries, setGentlemanSeries] = useState<PublicProduct[]>([]);
  const [categories, setCategories] = useState<PublicCategory[]>([]);
  const [archivePreview, setArchivePreview] = useState<PublicProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?sort=newest&pageSize=8"),
      api.get<PaginatedResult<PublicProduct>>("/api/public/products?isFeatured=true&pageSize=8"),
      api.get<PaginatedResult<PublicProduct>>(
        "/api/public/products?categorySlug=gentleman-series&pageSize=8",
      ),
      api.get<{ items: PublicCategory[] }>("/api/public/categories"),
      api.get<PaginatedResult<PublicProduct>>("/api/public/products/archive?pageSize=4"),
    ])
      .then(([arrivals, featuredRes, gentleman, categoriesRes, archiveRes]) => {
        setNewArrivals(arrivals.items);
        setFeatured(featuredRes.items);
        setGentlemanSeries(gentleman.items);
        setCategories(categoriesRes.items);
        setArchivePreview(archiveRes.items);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <section style={{ position: "relative", padding: "100px 40px", textAlign: "center" }}>
        <ConstellationBackground />
        <div style={{ position: "relative" }}>
          <p
            style={{
              margin: 0,
              fontSize: 13,
              letterSpacing: "0.08em",
              color: "var(--noctella-bright-star-gold)",
              textTransform: "uppercase",
            }}
          >
            Noctella
          </p>
          <p style={{ margin: "4px 0 24px", fontSize: 13, color: "var(--noctella-aged-bronze)", fontStyle: "italic" }}>
            Nova Vita ex Praeterito
          </p>
          <h1 style={{ fontSize: 44, lineHeight: 1.2, margin: 0 }}>
            Objects With a Past.
            <br />
            Stories Reborn.
          </h1>
          <p style={{ color: "var(--noctella-aged-bronze)", maxWidth: 520, margin: "20px auto" }}>
            Curated vintage objects, preserved for a new life.
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 24, flexWrap: "wrap" }}>
            <Link href="/shop" style={primaryCtaStyle}>
              Explore the Collection
            </Link>
            <Link href="/about" style={secondaryCtaStyle}>
              Discover Our Story
            </Link>
          </div>
        </div>
      </section>

      {!loading && newArrivals.length > 0 && (
        <HomeSection title="New Arrivals" viewAllHref="/shop">
          <ProductRow products={newArrivals} />
        </HomeSection>
      )}

      {!loading && categories.length > 0 && (
        <HomeSection title="Shop by Category">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 16,
            }}
          >
            {categories.map((category) => (
              <Link
                key={category.id}
                href={`/category/${category.slug}`}
                className="noctella-panel"
                style={{
                  display: "block",
                  padding: 20,
                  textAlign: "center",
                  textDecoration: "none",
                  color: "var(--noctella-ivory)",
                  fontSize: 14,
                }}
              >
                {category.name}
              </Link>
            ))}
          </div>
        </HomeSection>
      )}

      {!loading && featured.length > 0 && (
        <HomeSection title="Featured Objects" viewAllHref="/shop">
          <ProductRow products={featured} />
        </HomeSection>
      )}

      {!loading && gentlemanSeries.length > 0 && (
        <HomeSection title="Gentleman Series" viewAllHref="/category/gentleman-series">
          <ProductRow products={gentlemanSeries} />
        </HomeSection>
      )}

      <HomeSection title="Every Object Has a Story">
        <p style={{ maxWidth: 640, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
          Each piece in the Noctella collection carries a history — a life lived before it found its
          way here. We preserve what time has touched, and give it a place under the same fixed
          stars, ready to be part of someone&apos;s story once again.
        </p>
      </HomeSection>

      {!loading && archivePreview.length > 0 && (
        <HomeSection title="Archive / Sold Gallery" viewAllHref="/archive">
          <ProductRow products={archivePreview} />
        </HomeSection>
      )}

      <HomeSection title="Newsletter">
        <form
          onSubmit={(e) => e.preventDefault()}
          style={{ display: "flex", gap: 10, flexWrap: "wrap", maxWidth: 420 }}
        >
          <label htmlFor="newsletter-email" style={{ position: "absolute", left: -9999 }}>
            Email address
          </label>
          <input
            id="newsletter-email"
            type="email"
            placeholder="Your email"
            style={{
              flex: 1,
              minWidth: 200,
              background: "var(--noctella-night-navy)",
              border: "1px solid var(--noctella-aged-bronze)",
              color: "var(--noctella-ivory)",
              borderRadius: 4,
              padding: "10px 12px",
              fontSize: 14,
            }}
          />
          <button type="submit" style={primaryCtaStyle}>
            Subscribe
          </button>
        </form>
      </HomeSection>
    </div>
  );
}

function HomeSection({
  title,
  viewAllHref,
  children,
}: {
  title: string;
  viewAllHref?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: "40px 40px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ fontSize: 22 }}>{title}</h2>
        {viewAllHref && (
          <Link href={viewAllHref} style={{ fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
            View all
          </Link>
        )}
      </div>
      <hr className="noctella-divider" style={{ margin: "12px 0 20px" }} />
      {children}
    </section>
  );
}

function ProductRow({ products }: { products: PublicProduct[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 20,
      }}
    >
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}

const primaryCtaStyle: React.CSSProperties = {
  padding: "12px 24px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  border: "none",
  cursor: "pointer",
};

const secondaryCtaStyle: React.CSSProperties = {
  padding: "12px 24px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  fontSize: 14,
  textDecoration: "none",
};
