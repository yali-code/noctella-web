"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getWishlistIds } from "@/lib/wishlist";
import { cartItemCount, getCart } from "@/lib/cart";

const NAV_ITEMS = [
  { label: "Home", href: "/" },
  { label: "Shop", href: "/shop" },
  { label: "Categories", href: "/categories" },
  { label: "Collections", href: "/collections" },
  { label: "Gentleman Series", href: "/category/gentleman-series" },
  { label: "Archive", href: "/archive" },
  { label: "About", href: "/about" },
];

export function Header() {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [wishlistCount, setWishlistCount] = useState(0);
  const [cartCount, setCartCount] = useState(0);

  useEffect(() => {
    setWishlistCount(getWishlistIds().length);
    setCartCount(cartItemCount(getCart()));
    const onWishlistUpdate = () => setWishlistCount(getWishlistIds().length);
    const onCartUpdate = () => setCartCount(cartItemCount(getCart()));
    window.addEventListener("storage", onWishlistUpdate);
    window.addEventListener("storage", onCartUpdate);
    window.addEventListener("noctella:wishlist-updated", onWishlistUpdate);
    window.addEventListener("noctella:cart-updated", onCartUpdate);
    return () => {
      window.removeEventListener("storage", onWishlistUpdate);
      window.removeEventListener("storage", onCartUpdate);
      window.removeEventListener("noctella:wishlist-updated", onWishlistUpdate);
      window.removeEventListener("noctella:cart-updated", onCartUpdate);
    };
  }, []);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/shop?search=${encodeURIComponent(search)}`);
    setMenuOpen(false);
  }

  return (
    <header
      style={{
        borderBottom: "1px solid var(--noctella-antique-gold)",
        padding: "16px 24px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <Link href="/" style={{ textDecoration: "none" }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Noctella</h1>
        </Link>

        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label="Toggle navigation menu"
          className="noctella-mobile-menu-toggle"
          style={{
            display: "none",
            background: "none",
            border: "1px solid var(--noctella-antique-gold)",
            color: "var(--noctella-ivory)",
            borderRadius: 4,
            padding: "8px 12px",
            cursor: "pointer",
          }}
        >
          Menu
        </button>

        <nav
          className="noctella-nav"
          style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}
        >
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} style={{ fontSize: 14 }}>
              {item.label}
            </Link>
          ))}

          <form onSubmit={handleSearchSubmit} role="search" style={{ display: "flex", alignItems: "center" }}>
            <label htmlFor="storefront-search" style={{ position: "absolute", left: -9999 }}>
              Search products
            </label>
            <input
              id="storefront-search"
              type="search"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                background: "var(--noctella-deep-star-blue)",
                border: "1px solid var(--noctella-antique-gold)",
                color: "var(--noctella-ivory)",
                borderRadius: 4,
                padding: "6px 10px",
                fontSize: 13,
                width: 130,
              }}
            />
          </form>

          <Link href="/wishlist" style={{ fontSize: 14 }} aria-label={`Wishlist (${wishlistCount} items)`}>
            Wishlist{wishlistCount > 0 ? ` (${wishlistCount})` : ""}
          </Link>
          <Link href="/account" style={{ fontSize: 14 }}>
            Account
          </Link>
          <Link href="/cart" style={{ fontSize: 14 }} aria-label={`Cart (${cartCount} items)`}>
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </Link>
        </nav>
      </div>

      {menuOpen && (
        <nav
          className="noctella-mobile-nav"
          style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}
        >
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} style={{ fontSize: 14 }} onClick={() => setMenuOpen(false)}>
              {item.label}
            </Link>
          ))}
          <Link href="/wishlist" style={{ fontSize: 14 }} onClick={() => setMenuOpen(false)}>
            Wishlist{wishlistCount > 0 ? ` (${wishlistCount})` : ""}
          </Link>
          <Link href="/account" style={{ fontSize: 14 }} onClick={() => setMenuOpen(false)}>
            Account
          </Link>
          <Link href="/cart" style={{ fontSize: 14 }} onClick={() => setMenuOpen(false)}>
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </Link>
        </nav>
      )}
    </header>
  );
}
