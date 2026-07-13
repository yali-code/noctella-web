export interface AdminMenuItem {
  label: string;
  href: string;
}

export const adminMenuItems: AdminMenuItem[] = [
  { label: "Dashboard", href: "/" },
  { label: "Live Visitors", href: "/live-visitors" },
  { label: "Products", href: "/products" },
  { label: "Categories", href: "/categories" },
  { label: "Collections", href: "/collections" },
  { label: "AI Drafts", href: "/ai-drafts" },
  { label: "Orders", href: "/orders" },
  { label: "Stock", href: "/stock" },
  { label: "Customers", href: "/customers" },
  { label: "Offers", href: "/offers" },
  { label: "Marketing", href: "/marketing" },
  { label: "Reports", href: "/reports" },
  { label: "Analytics", href: "/analytics" },
  { label: "Shipping", href: "/shipping" },
  { label: "Payments", href: "/payments" },
  { label: "Currencies", href: "/currencies" },
  { label: "Coupons", href: "/coupons" },
  { label: "Pages", href: "/pages" },
  { label: "Blog / Stories", href: "/blog" },
  { label: "SEO", href: "/seo" },
  { label: "AI Support", href: "/ai-support" },
  { label: "Users & Roles", href: "/users-roles" },
  { label: "Settings", href: "/settings" },
];
