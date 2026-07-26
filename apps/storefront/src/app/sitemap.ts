import type { MetadataRoute } from "next";
import { buildCanonicalUrl, collectAllPages, fetchPublicJson, SITEMAP_STATIC_PATHS } from "@/lib/seo";
import type { PaginatedResult, PublicCategory, PublicCollection, PublicProduct } from "@/lib/types";

/** Sitemap freshness is not critical for the current catalog size - re-derived hourly. */
export const revalidate = 3600;

const PRODUCT_PAGE_SIZE = 100;

/**
 * Sprint 73: `/api/public/products` already filters to published-only server-side (see
 * services/publicCatalog.ts's listPublicProducts), so looping it can never surface an
 * unpublished/draft/sold product URL - no extra status filtering is needed here. Categories and
 * collections have no updatedAt field in the public API, so their entries omit `lastModified`
 * rather than inventing a date; products do expose a real `updatedAt`, which is used as-is.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [categoriesRes, collectionsRes] = await Promise.all([
    fetchPublicJson<{ items: PublicCategory[] }>("/api/public/categories"),
    fetchPublicJson<{ items: PublicCollection[] }>("/api/public/collections"),
  ]);

  const products = await collectAllPages<PublicProduct>((page) =>
    fetchPublicJson<PaginatedResult<PublicProduct>>(
      `/api/public/products?page=${page}&pageSize=${PRODUCT_PAGE_SIZE}`,
    ),
  );

  const staticEntries: MetadataRoute.Sitemap = SITEMAP_STATIC_PATHS.map((path) => ({
    url: buildCanonicalUrl(path),
  }));

  const categoryEntries: MetadataRoute.Sitemap = (categoriesRes?.items ?? []).map((category) => ({
    url: buildCanonicalUrl(`/category/${category.slug}`),
  }));

  const collectionEntries: MetadataRoute.Sitemap = (collectionsRes?.items ?? []).map((collection) => ({
    url: buildCanonicalUrl(`/collection/${collection.slug}`),
  }));

  const productEntries: MetadataRoute.Sitemap = products.map((product) => ({
    url: buildCanonicalUrl(`/product/${product.slug}`),
    ...(product.updatedAt ? { lastModified: new Date(product.updatedAt) } : {}),
  }));

  return [...staticEntries, ...categoryEntries, ...collectionEntries, ...productEntries];
}
