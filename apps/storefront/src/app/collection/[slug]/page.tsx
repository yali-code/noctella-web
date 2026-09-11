import type { Metadata } from "next";
import {
  buildCanonicalUrl,
  buildEntityTitle,
  buildUnavailableMetadata,
  chooseDescription,
  fetchPublicJson,
  resolveAbsoluteImageUrl,
} from "@/lib/seo";
import type { PublicCollection } from "@/lib/types";
import { normalizeTaxonomyPage } from "@/lib/taxonomyBrowseParams";
import { CollectionPageClient } from "./CollectionPageClient";

interface CollectionPageProps {
  params: { slug: string };
  searchParams?: { page?: string | string[] };
}

/** Never calls notFound() - a missing collection still lets CollectionPageClient render its own state. */
export async function generateMetadata({ params }: CollectionPageProps): Promise<Metadata> {
  const collection = await fetchPublicJson<PublicCollection>(`/api/public/collections/${params.slug}`);
  if (!collection) return buildUnavailableMetadata("Collection Unavailable");

  const canonicalUrl = buildCanonicalUrl(`/collection/${params.slug}`);
  const title = buildEntityTitle(collection.seoTitle, collection.name);
  const description = chooseDescription(collection.metaDescription, collection.description);
  const absoluteImageUrl = resolveAbsoluteImageUrl(collection.coverImageUrl);

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

export default function CollectionPage({ params, searchParams }: CollectionPageProps) {
  return <CollectionPageClient slug={params.slug} page={normalizeTaxonomyPage(searchParams?.page)} />;
}
