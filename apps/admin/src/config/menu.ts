export interface AdminMenuItem {
  label: string;
  href: string;
}

export interface AdminMenuGroup {
  label: string;
  items: AdminMenuItem[];
}

/** Sidebar groups. Pages, routes and permissions are unchanged; only the menu layout is grouped. */
export const adminMenuGroups: AdminMenuGroup[] = [
  {
    label: "Dashboard",
    items: [
      { label: "Dashboard", href: "/" },
      { label: "Live Visitors", href: "/live-visitors" },
      { label: "Reports", href: "/reports" },
      { label: "Analytics", href: "/analytics" },
    ],
  },
  {
    label: "Products",
    items: [
      { label: "Products", href: "/products" },
      { label: "Pending Publish", href: "/ready-to-publish" },
      { label: "Categories", href: "/categories" },
      { label: "Collections", href: "/collections" },
      { label: "AI Product Intake", href: "/ai-product-intakes" },
      { label: "AI Drafts", href: "/ai-drafts" },
    ],
  },
  {
    label: "Stock & Warehouse",
    items: [
      { label: "Stock", href: "/stock" },
      { label: "Warehouses", href: "/warehouses" },
      { label: "Reservations", href: "/reservations" },
      { label: "Stock Sync", href: "/stock-sync" },
      { label: "Stock Conflicts", href: "/stock-sync/conflicts" },
    ],
  },
  {
    label: "Sales",
    items: [
      { label: "Orders", href: "/orders" },
      { label: "Complete Sales", href: "/complete-sales" },
      { label: "Returns", href: "/returns" },
      { label: "Refunds", href: "/refunds" },
      { label: "Customers", href: "/customers" },
      { label: "Offers", href: "/offers" },
    ],
  },
  {
    label: "Shipping",
    items: [
      { label: "Shipping", href: "/shipping" },
      { label: "Shipping Methods", href: "/settings/shipping" },
      { label: "Shipments", href: "/shipments" },
      { label: "Picking", href: "/picking" },
      { label: "Packing", href: "/packing" },
      { label: "Shipment Ready", href: "/warehouse/shipment-ready" },
    ],
  },
  {
    label: "Marketplaces",
    items: [
      { label: "Marketplaces", href: "/marketplaces" },
      { label: "Marketplace Orders", href: "/marketplace-orders" },
      { label: "Marketplace Sync", href: "/marketplace-sync" },
      { label: "External Listings", href: "/external-listings" },
      { label: "Publish Jobs", href: "/publish-jobs" },
    ],
  },
  {
    label: "Finance & Purchasing",
    items: [
      { label: "Finance", href: "/finance" },
      { label: "eBay Statements", href: "/finance/ebay-statements" },
      { label: "Invoices", href: "/invoices" },
      { label: "Invoice Cost Sets", href: "/invoice-cost-sets" },
      { label: "Purchases", href: "/purchases" },
      { label: "Suppliers", href: "/suppliers" },
      { label: "Payments", href: "/payments" },
      { label: "Currencies", href: "/currencies" },
    ],
  },
  {
    label: "Marketing & Content",
    items: [
      { label: "Marketing", href: "/marketing" },
      { label: "Social Manager", href: "/social" },
      { label: "Coupons", href: "/coupons" },
      { label: "Pages", href: "/pages" },
      { label: "Blog / Stories", href: "/blog" },
      { label: "SEO", href: "/seo" },
      { label: "AI Support", href: "/ai-support" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Settings", href: "/settings" },
      { label: "Users & Roles", href: "/users-roles" },
      { label: "ERP Integration", href: "/erp-integration" },
      { label: "ERP Migration", href: "/erp-migration" },
      { label: "Database", href: "/database" },
      { label: "Migration", href: "/database/migration" },
      { label: "Background Jobs", href: "/background-jobs" },
    ],
  },
];

export const adminMenuItems: AdminMenuItem[] = adminMenuGroups.flatMap((group) => group.items);

/** The group holding the most specific menu link for this path, so its section opens by itself. */
export function activeMenuGroupLabel(pathname: string): string | null {
  let best: { group: string; length: number } | null = null;
  for (const group of adminMenuGroups) {
    for (const item of group.items) {
      const matches = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (matches && (!best || item.href.length > best.length)) best = { group: group.label, length: item.href.length };
    }
  }
  return best?.group ?? null;
}
