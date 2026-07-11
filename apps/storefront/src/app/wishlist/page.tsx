"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ProductGrid } from "@/components/ProductGrid";
import { getWishlistIds } from "@/lib/wishlist";
import type { PaginatedResult, PublicProduct } from "@/lib/types";

export default function WishlistPage() {
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ids = getWishlistIds();
    if (ids.length === 0) {
      setLoading(false);
      return;
    }
    // No bulk/by-id public endpoint exists yet; fetch the published catalog
    // and filter client-side by the ids stored in localStorage.
    api
      .get<PaginatedResult<PublicProduct>>("/api/public/products?pageSize=100")
      .then((res) => {
        const idSet = new Set(ids);
        setProducts(res.items.filter((p) => idSet.has(p.id)));
      })
      .catch(() => setError("Something went wrong loading your wishlist. Please try again."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>Wishlist</h1>
      <p style={{ color: "var(--noctella-aged-bronze)", maxWidth: 560 }}>
        Saved on this device only — no account required.
      </p>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <ProductGrid
        products={products}
        loading={loading}
        error={error}
        emptyMessage="Your wishlist is empty. Browse the shop and tap “Add to Wishlist” to save pieces here."
      />
    </section>
  );
}
