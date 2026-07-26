import { resolveServiceUrl } from "@noctella/shared";
import type { PublicProduct } from "./types";

export const SITE_DEFAULT_TITLE = "Noctella — Objects With A Past";
export const SITE_DEFAULT_DESCRIPTION = "Noctella — Nova Vita ex Praeterito. A collector's night sky.";

/** Public static routes with no dynamic entity behind them - used by the sitemap. */
export const SITEMAP_STATIC_PATHS = ["/", "/shop", "/categories", "/collections", "/archive", "/about"];

/**
 * Server-only canonical Storefront origin. Deliberately a plain (non-NEXT_PUBLIC_) env var:
 * it's read only in Server Components/metadata routes, never inlined into the client bundle.
 * Parsed via `new URL()` (not a regex prefix check) and reduced to `.origin` - this rejects
 * bare/malformed values (e.g. a schemeless host, or a bare "https://" with no host, which the
 * WHATWG URL parser itself treats as invalid for a special scheme) and, just as importantly,
 * silently discards any path/query string/fragment an operator might accidentally include in the
 * configured value, so a misconfigured var can never leak into a canonical/OG URL. A localhost
 * fallback is only allowed outside production - a missing/invalid value in production fails
 * loudly instead of silently emitting broken canonical/OG URLs. Never derived from request
 * headers, so it cannot be poisoned by a spoofed Host header.
 */
export function getStorefrontSiteUrl(): string {
  const raw = process.env.STOREFRONT_SITE_URL;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("STOREFRONT_SITE_URL is required in production but is not set");
    }
    return "http://localhost:3000";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`STOREFRONT_SITE_URL must be a valid absolute URL (received "${raw}")`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`STOREFRONT_SITE_URL must use http:// or https:// (received "${raw}")`);
  }
  return parsed.origin;
}

/** Builds an absolute canonical URL for a given site-relative pathname (e.g. "/product/x"). */
export function buildCanonicalUrl(pathname: string): string {
  const siteUrl = getStorefrontSiteUrl();
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${siteUrl}${normalizedPath}`;
}

/**
 * The Shop page's canonical must always be the bare /shop, regardless of ?search=/?page=/?sort=/
 * ?categorySlug=/?collectionSlug= - each filter/pagination combination is not a distinct page for
 * SEO purposes, and treating them as such would create duplicate-content variants.
 */
export function shopCanonicalUrl(): string {
  return buildCanonicalUrl("/shop");
}

/**
 * Server-only fetch helper shared by every dynamic route's generateMetadata AND its page
 * render function. Next.js automatically memoizes/deduplicates identical `fetch(url, options)`
 * calls made during the same render pass, so calling this twice per request (once from
 * generateMetadata, once from the page component) issues a single real network request - no
 * custom caching library is introduced. Returns null on any non-2xx response or network error
 * rather than throwing, so callers can fall back to safe generic metadata instead of crashing
 * the route. `revalidate: 60` keeps server-rendered metadata reasonably fresh without hammering
 * the API on every request; it does not affect the client component's own independent fetch.
 */
export async function fetchPublicJson<T>(path: string): Promise<T | null> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${apiBaseUrl}${path}`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Resolves an API-relative asset URL (e.g. "/images/product-photos/x.webp") to an absolute URL. */
export function resolveAbsoluteImageUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  return resolveServiceUrl(value, apiBaseUrl);
}

/** First present, non-empty candidate wins; falls back to `fallback` if none are usable. */
function firstNonEmpty(candidates: Array<string | undefined | null>, fallback: string): string {
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate;
  }
  return fallback;
}

/**
 * Builds a complete, self-contained title for a product/category/collection page. When an admin
 * has set a custom `seoTitle`, it is used exactly as entered (the admin controls the full title,
 * including whether "Noctella" appears in it) - callers must set this via `title: { absolute }`
 * so the root layout's `%s — Noctella` template does not additionally suffix it. Only the
 * generated fallback (no custom seoTitle) appends the site name itself.
 */
export function buildEntityTitle(seoTitle: string | undefined, name: string): string {
  if (seoTitle && seoTitle.trim().length > 0) return seoTitle;
  return `${name} — Noctella`;
}

export function chooseDescription(
  metaDescription: string | undefined,
  description: string | undefined,
  fallback = SITE_DEFAULT_DESCRIPTION,
): string {
  return firstNonEmpty([metaDescription, description], fallback);
}

/** Generic metadata for a slug that could not be resolved to a real, published entity. */
export function buildUnavailableMetadata(fallbackTitle: string) {
  return {
    title: fallbackTitle,
    description: SITE_DEFAULT_DESCRIPTION,
    robots: { index: false, follow: true },
  };
}

const CONDITION_TO_SCHEMA_ORG: Record<string, string> = {
  new: "https://schema.org/NewCondition",
  used: "https://schema.org/UsedCondition",
  "pre-owned": "https://schema.org/UsedCondition",
  preowned: "https://schema.org/UsedCondition",
  refurbished: "https://schema.org/RefurbishedCondition",
  damaged: "https://schema.org/DamagedCondition",
  "for parts": "https://schema.org/DamagedCondition",
};

/**
 * `condition` is free text entered in Admin (no enum) - only a small, conservative whitelist of
 * unambiguous values is mapped to schema.org's itemCondition. Anything else is omitted rather
 * than guessed, so unrecognized admin text never produces an incorrect claim.
 */
export function mapConditionToSchemaOrg(condition: string | undefined): string | undefined {
  if (!condition) return undefined;
  return CONDITION_TO_SCHEMA_ORG[condition.trim().toLowerCase()];
}

/**
 * Availability must never be guessed. `PublicProduct` does not currently expose any
 * stock/sellable-quantity field, so this always returns undefined today - it exists so that if
 * such a field is ever added to the public API, availability can be wired up without touching
 * the JSON-LD builder itself. Never derive availability from `status === "published"` -
 * published means publicly visible, not necessarily in stock.
 */
export function mapAvailability(stockIndicator?: "in_stock" | "out_of_stock"): string | undefined {
  if (stockIndicator === "in_stock") return "https://schema.org/InStock";
  if (stockIndicator === "out_of_stock") return "https://schema.org/OutOfStock";
  return undefined;
}

export interface ProductJsonLdInput {
  product: Pick<
    PublicProduct,
    "title" | "description" | "brand" | "manufacturer" | "condition" | "priceEur" | "status"
  >;
  canonicalUrl: string;
  absoluteImageUrls: string[];
}

/** Builds a schema.org Product JSON-LD object, omitting every field that isn't real data. */
export function buildProductJsonLd({ product, canonicalUrl, absoluteImageUrls }: ProductJsonLdInput): Record<string, unknown> {
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
  };

  if (product.description) jsonLd.description = product.description;
  if (absoluteImageUrls.length > 0) jsonLd.image = absoluteImageUrls;

  const brandName = product.brand || product.manufacturer;
  if (brandName) jsonLd.brand = { "@type": "Brand", name: brandName };

  const itemCondition = mapConditionToSchemaOrg(product.condition);
  if (itemCondition) jsonLd.itemCondition = itemCondition;

  if (typeof product.priceEur === "number" && Number.isFinite(product.priceEur) && product.priceEur >= 0) {
    const offer: Record<string, unknown> = {
      "@type": "Offer",
      priceCurrency: "EUR",
      price: product.priceEur.toFixed(2),
      url: canonicalUrl,
    };
    const availability = mapAvailability();
    if (availability) offer.availability = availability;
    jsonLd.offers = offer;
  }

  return jsonLd;
}

export interface PaginatedLike<T> {
  items: T[];
  total: number;
}

/** Hard circuit-breaker so a malformed/never-decreasing `total` from the API cannot loop forever. */
const MAX_SITEMAP_PAGES = 500;

/**
 * Generic paginated-collection helper used by the sitemap to enumerate every product across the
 * existing public product-list endpoint's pages, without adding a new "all slugs" API endpoint.
 * `fetchPage` is injected so this stays a pure, directly-testable function - it never calls
 * `fetch` itself. Stops cleanly on an empty/missing page (in case of a genuinely empty catalog),
 * and on a non-advancing/invalid `total` (falls back to what's been collected so far) rather than
 * trusting the API's `total` field blindly, in addition to the hard page-count cap above.
 */
export async function collectAllPages<T>(
  fetchPage: (page: number) => Promise<PaginatedLike<T> | null>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let total = Infinity;

  while (all.length < total && page <= MAX_SITEMAP_PAGES) {
    const result = await fetchPage(page);
    if (!result || !Array.isArray(result.items) || result.items.length === 0) break;
    all.push(...result.items);
    total = typeof result.total === "number" && result.total >= 0 ? result.total : all.length;
    page += 1;
  }

  return all;
}

/**
 * Escapes `<` so a `</script>`-like sequence inside serialized JSON-LD data can never prematurely
 * close the surrounding <script> tag (the classic JSON-in-HTML injection vector). `<` never
 * legitimately appears in valid JSON output otherwise, so this is a safe, minimal escape.
 */
export function safeJsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
