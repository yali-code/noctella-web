import type { Metadata } from "next";
import { buildCanonicalUrl, SITE_DEFAULT_DESCRIPTION, SITE_DEFAULT_TITLE } from "@/lib/seo";
import { HomeClient } from "./HomeClient";

export const metadata: Metadata = {
  title: { absolute: SITE_DEFAULT_TITLE },
  description: SITE_DEFAULT_DESCRIPTION,
  alternates: { canonical: buildCanonicalUrl("/") },
};

export default function HomePage() {
  return <HomeClient />;
}
