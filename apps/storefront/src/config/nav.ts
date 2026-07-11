export interface StorefrontNavItem {
  label: string;
  href: string;
}

/**
 * Footer-only links. Primary header navigation lives in
 * components/Header.tsx (it needs client-side state for the mobile menu
 * and search box, so its nav list is defined there instead of duplicated
 * here).
 */
export const storefrontFooterItems: StorefrontNavItem[] = [
  { label: "Shipping & Delivery", href: "/shipping-delivery" },
  { label: "Returns Policy", href: "/returns-policy" },
  { label: "Customs & Import Duties", href: "/customs-duties" },
  { label: "FAQ", href: "/faq" },
  { label: "Contact", href: "/contact" },
];
