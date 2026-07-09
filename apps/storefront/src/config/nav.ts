export interface StorefrontNavItem {
  label: string;
  href: string;
}

export const storefrontNavItems: StorefrontNavItem[] = [
  { label: "Shop", href: "/shop" },
  { label: "Archive / Sold Gallery", href: "/archive" },
  { label: "About Noctella", href: "/about" },
  { label: "Contact", href: "/contact" },
];

export const storefrontFooterItems: StorefrontNavItem[] = [
  { label: "Shipping & Delivery", href: "/shipping-delivery" },
  { label: "Returns Policy", href: "/returns-policy" },
  { label: "Customs & Import Duties", href: "/customs-duties" },
  { label: "FAQ", href: "/faq" },
];
