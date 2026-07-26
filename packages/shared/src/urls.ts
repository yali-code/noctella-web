/**
 * Sprint 70: the API stores and returns product-photo URLs as portable relative paths (e.g.
 * "/images/product-photos/example.webp") so the same value works unchanged across
 * localhost/staging/production and never gets baked into the database, product metadata, cart
 * localStorage, or checkout drafts. Resolving that relative path against a concrete service
 * origin is a presentation-layer concern only - this helper does exactly that, and nothing else.
 *
 * Absolute URLs (any scheme, protocol-relative "//", data:, blob:) are returned completely
 * unchanged - never normalized, rewritten, or re-encoded - since they already point at a
 * specific, correct location (e.g. an external marketplace image).
 */
export function resolveServiceUrl(value: string | null | undefined, baseUrl: string): string {
  if (!value) return "";
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^(?:data|blob):/i.test(value)) return value;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = value.startsWith("/") ? value : `/${value}`;
  return `${normalizedBase}${normalizedPath}`;
}
