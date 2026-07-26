export interface StorefrontNavItem {
  label: string;
  href: string;
}

/**
 * Sprint 72: moved here (a plain, non-JSX module) rather than staying inline in
 * components/Header.tsx so it can be imported by tests without needing JSX/component-test
 * tooling - the storefront's Vitest setup only parses plain .ts files, not .tsx.
 */
export const storefrontHeaderNavItems: StorefrontNavItem[] = [
  { label: "Home", href: "/" },
  { label: "Shop", href: "/shop" },
  { label: "Categories", href: "/categories" },
  { label: "Collections", href: "/collections" },
  { label: "Gentleman Series", href: "/category/gentleman-series" },
  { label: "Archive", href: "/archive" },
  { label: "About", href: "/about" },
];

/** Footer-only links. */
export const storefrontFooterItems: StorefrontNavItem[] = [
  { label: "Shipping & Delivery", href: "/shipping-delivery" },
  { label: "Returns Policy", href: "/returns-policy" },
  { label: "Customs & Import Duties", href: "/customs-duties" },
  { label: "FAQ", href: "/faq" },
  { label: "Contact", href: "/contact" },
];
