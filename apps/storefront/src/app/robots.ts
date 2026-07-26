import type { MetadataRoute } from "next";
import { buildCanonicalUrl } from "@/lib/seo";

/**
 * Sprint 73: robots.txt blocks crawling of the transactional/personal route trees entirely
 * (checkout, account). Cart and wishlist are guest-state pages with no sensitive data, so they
 * are left crawlable but noindexed via their own route metadata (cart/layout.tsx,
 * wishlist/layout.tsx) instead - a stronger crawl block isn't warranted for them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/checkout", "/account"],
    },
    sitemap: buildCanonicalUrl("/sitemap.xml"),
  };
}
