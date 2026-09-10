"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SearchForm } from "@/components/SearchForm";
import { getWishlistIds } from "@/lib/wishlist";
import { cartItemCount, getCart } from "@/lib/cart";
import { storefrontHeaderNavItems as NAV_ITEMS, storefrontSecondaryNavItems as SECONDARY_ITEMS } from "@/config/nav";

const MOBILE_NAV_ID = "storefront-mobile-navigation";

export function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [wishlistCount, setWishlistCount] = useState(0);
  const [cartCount, setCartCount] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);

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

  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    mobileNavRef.current?.querySelector<HTMLElement>("input, a, button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);
  return (
    <header className="sf-header">
      <div className="sf-header__bar">
        <Link href="/" className="sf-brand" aria-label="Noctella home">Noctella</Link>
        <button ref={triggerRef} type="button" onClick={() => setMenuOpen((value) => !value)}
          aria-expanded={menuOpen} aria-controls={MOBILE_NAV_ID} aria-label="Toggle navigation menu"
          className="sf-menu-toggle noctella-mobile-menu-toggle">Menu</button>
        <nav className="sf-desktop-nav noctella-nav" aria-label="Main navigation">
          <SearchForm compact />
          {NAV_ITEMS.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
          <AccountLinks wishlistCount={wishlistCount} cartCount={cartCount} onNavigate={closeMenu} />
        </nav>
      </div>
      {menuOpen && (
        <nav ref={mobileNavRef} id={MOBILE_NAV_ID} className="sf-mobile-nav noctella-mobile-nav" aria-label="Mobile navigation">
          <SearchForm compact onNavigate={closeMenu} />
          {NAV_ITEMS.map((item) => <Link key={item.href} href={item.href} onClick={closeMenu}>{item.label}</Link>)}
          <span className="sf-mobile-nav__label">More from Noctella</span>
          {SECONDARY_ITEMS.map((item) => <Link key={item.href} href={item.href} onClick={closeMenu}>{item.label}</Link>)}
          <AccountLinks wishlistCount={wishlistCount} cartCount={cartCount} onNavigate={closeMenu} />
        </nav>
      )}
    </header>
  );
}

function AccountLinks({ wishlistCount, cartCount, onNavigate }: { wishlistCount: number; cartCount: number; onNavigate: () => void }) {
  return <>
    <Link href="/wishlist" aria-label={`Wishlist (${wishlistCount} items)`} onClick={onNavigate}>Wishlist{wishlistCount ? ` (${wishlistCount})` : ""}</Link>
    <Link href="/cart" aria-label={`Cart (${cartCount} items)`} onClick={onNavigate}>Cart{cartCount ? ` (${cartCount})` : ""}</Link>
  </>;
}
