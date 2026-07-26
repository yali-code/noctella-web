import type { Metadata } from "next";
import { buildCanonicalUrl } from "@/lib/seo";

/** Sprint 73: sibling Server Component layout so /categories/page.tsx does not need to change. */
export const metadata: Metadata = {
  title: "Categories",
  description: "Browse Noctella's curated categories of vintage objects.",
  alternates: { canonical: buildCanonicalUrl("/categories") },
};

export default function CategoriesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
