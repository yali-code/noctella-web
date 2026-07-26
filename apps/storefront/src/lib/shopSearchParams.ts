/**
 * Normalizes the Shop page's `search` URL query value. `URLSearchParams.get("search")` already
 * decodes percent-encoded characters and collapses a repeated `?search=a&search=b` query to the
 * first value - this just fills in the "missing" case with an empty string so callers never have
 * to deal with `null`. Accepts a string array too, so the "repeated params" case is normalized
 * the same way even if a caller ever reads raw query values instead of `URLSearchParams.get()`.
 */
export function normalizeShopSearchParam(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
