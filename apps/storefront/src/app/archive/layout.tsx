import type { Metadata } from "next";
import { buildCanonicalUrl } from "@/lib/seo";

/** Sprint 73: sibling Server Component layout so /archive/page.tsx does not need to change. */
export const metadata: Metadata = {
  title: "Archive / Sold Gallery",
  description: "A record of Noctella objects that have found their next home.",
  alternates: { canonical: buildCanonicalUrl("/archive") },
};

export default function ArchiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
