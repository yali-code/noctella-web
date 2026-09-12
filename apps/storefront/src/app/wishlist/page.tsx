"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ProductGrid } from "@/components/ProductGrid";
import { getWishlistIds } from "@/lib/wishlist";
import type { PaginatedResult, PublicProduct } from "@/lib/types";

export default function WishlistPage() {
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);
  const [resolvedProducts, setResolvedProducts] = useState<PublicProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const resolvedProductsRef = useRef<PublicProduct[]>([]);
  const synchronizationGeneration = useRef(0);

  useEffect(() => {
    function synchronize() {
      const generation = ++synchronizationGeneration.current;
      const ids = getWishlistIds();
      setWishlistIds(ids);

      if (ids.length === 0) {
        setError(null);
        setLoading(false);
        return;
      }

      const resolvedIds = new Set(resolvedProductsRef.current.map((product) => product.id));
      if (ids.every((id) => resolvedIds.has(id))) {
        setError(null);
        setLoading(false);
        return;
      }

      const hasVisibleProducts = ids.some((id) => resolvedIds.has(id));
      setError(null);
      setLoading(!hasVisibleProducts);
      // The bounded catalog is deliberately unchanged; exact-ID completeness is a separate concern.
      api
        .get<PaginatedResult<PublicProduct>>("/api/public/products?pageSize=100")
        .then((res) => {
          if (generation !== synchronizationGeneration.current) return;
          resolvedProductsRef.current = res.items;
          setResolvedProducts(res.items);
        })
        .catch(() => {
          if (generation !== synchronizationGeneration.current || hasVisibleProducts) return;
          setError("Something went wrong loading your wishlist. Please try again.");
        })
        .finally(() => {
          if (generation === synchronizationGeneration.current) setLoading(false);
        });
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === "noctella_wishlist" || event.key === null) synchronize();
    };

    synchronize();
    window.addEventListener("noctella:wishlist-updated", synchronize);
    window.addEventListener("storage", onStorage);
    return () => {
      synchronizationGeneration.current += 1;
      window.removeEventListener("noctella:wishlist-updated", synchronize);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const products = useMemo(() => {
    const idSet = new Set(wishlistIds);
    return resolvedProducts.filter((product) => idSet.has(product.id));
  }, [resolvedProducts, wishlistIds]);

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
