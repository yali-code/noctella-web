import type { Metadata } from "next";
import { buildCanonicalUrl } from "@/lib/seo";

/** Sprint 73: sibling Server Component layout so /collections/page.tsx does not need to change. */
export const metadata: Metadata = {
  title: "Collections",
  description: "Browse Noctella's curated collections of vintage objects.",
  alternates: { canonical: buildCanonicalUrl("/collections") },
};

export default function CollectionsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
