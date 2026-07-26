import type { Metadata } from "next";
import {
  buildCanonicalUrl,
  buildEntityTitle,
  buildProductJsonLd,
  buildUnavailableMetadata,
  chooseDescription,
  fetchPublicJson,
  resolveAbsoluteImageUrl,
  safeJsonLdScript,
} from "@/lib/seo";
import type { PublicProductDetail } from "@/lib/types";
import { ProductDetailClient } from "./ProductDetailClient";

interface ProductPageProps {
  params: { slug: string };
}

async function fetchProduct(slug: string): Promise<PublicProductDetail | null> {
  return fetchPublicJson<PublicProductDetail>(`/api/public/products/${slug}`);
}

/**
 * Sprint 73: server-side fetch used only for metadata/JSON-LD. Never calls notFound() - a
 * missing/draft/sold/archived slug must fall through to safe generic, noindexed metadata and
 * still let ProductDetailClient mount and render Sprint 72's friendly "may have been sold or is
 * no longer available" UI, not Next's own not-found boundary.
 */
export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const product = await fetchProduct(params.slug);
  if (!product) return buildUnavailableMetadata("Product Unavailable");

  const canonicalUrl = buildCanonicalUrl(`/product/${params.slug}`);
  const title = buildEntityTitle(product.seoTitle, product.title);
  const description = chooseDescription(product.metaDescription, product.description);
  const primaryImage = product.photos?.find((p) => p.isPrimary) ?? product.photos?.[0] ?? product.images[0];
  const absoluteImageUrl = resolveAbsoluteImageUrl(primaryImage?.url);

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

export default async function ProductPage({ params }: ProductPageProps) {
  const product = await fetchProduct(params.slug);

  let jsonLdScript: string | null = null;
  if (product && product.status === "published") {
    const canonicalUrl = buildCanonicalUrl(`/product/${params.slug}`);
    const absoluteImageUrls = (product.photos && product.photos.length > 0 ? product.photos : product.images)
      .map((image) => resolveAbsoluteImageUrl(image.url))
      .filter((url): url is string => Boolean(url));
    const jsonLd = buildProductJsonLd({ product, canonicalUrl, absoluteImageUrls });
    jsonLdScript = safeJsonLdScript(jsonLd);
  }

  return (
    <>
      {jsonLdScript && (
        // eslint-disable-next-line react/no-danger
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript }} />
      )}
      <ProductDetailClient slug={params.slug} />
    </>
  );
}
