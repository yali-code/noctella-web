import type { Metadata } from "next";
import { shopCanonicalUrl } from "@/lib/seo";

/**
 * Sprint 73: a sibling Server Component layout so /shop/page.tsx (a Client Component) does not
 * need to change at all. The canonical is always the bare /shop, regardless of any
 * ?search=/?page=/?sort=/?categorySlug=/?collectionSlug= combination the client page manages -
 * those are not distinct pages for SEO purposes.
 */
export const metadata: Metadata = {
  title: "Shop",
  description: "Browse the full Noctella collection of curated vintage objects.",
  alternates: { canonical: shopCanonicalUrl() },
};

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return children;
}
