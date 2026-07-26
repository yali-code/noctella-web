import type { Metadata } from "next";
import {
  buildCanonicalUrl,
  buildEntityTitle,
  buildUnavailableMetadata,
  chooseDescription,
  fetchPublicJson,
  resolveAbsoluteImageUrl,
} from "@/lib/seo";
import type { PublicCategory } from "@/lib/types";
import { CategoryPageClient } from "./CategoryPageClient";

interface CategoryPageProps {
  params: { slug: string };
}

/** Never calls notFound() - a missing category still lets CategoryPageClient render its own state. */
export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const category = await fetchPublicJson<PublicCategory>(`/api/public/categories/${params.slug}`);
  if (!category) return buildUnavailableMetadata("Category Unavailable");

  const canonicalUrl = buildCanonicalUrl(`/category/${params.slug}`);
  const title = buildEntityTitle(category.seoTitle, category.name);
  const description = chooseDescription(category.metaDescription, category.description);
  const absoluteImageUrl = resolveAbsoluteImageUrl(category.displayImageUrl);

  return {
    title: { absolute: title },
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title,
      description,
      url: canonicalUrl,
      type: "website",
      images: absoluteImageUrl ? [{ url: absoluteImageUrl }] : undefined,
    },
  };
}

export default function CategoryPage({ params }: CategoryPageProps) {
  return <CategoryPageClient slug={params.slug} />;
}
