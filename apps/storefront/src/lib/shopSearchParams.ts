/**
 * Normalizes the Shop page's `search` URL query value. `URLSearchParams.get("search")` already
 * decodes percent-encoded characters and collapses a repeated `?search=a&search=b` query to the
 * first value - this just fills in the "missing" case with an empty string so callers never have
 * to deal with `null`. Accepts a string array too, so the "repeated params" case is normalized
 * the same way even if a caller ever reads raw query values instead of `URLSearchParams.get()`.
 */
export type ShopSort = "newest" | "price_asc" | "price_desc" | "title_asc";

export interface ShopBrowseState {
  search: string;
  category: string;
  collection: string;
  sort: ShopSort;
  page: number;
}

export const DEFAULT_SHOP_BROWSE_STATE: ShopBrowseState = {
  search: "",
  category: "",
  collection: "",
  sort: "newest",
  page: 1,
};

const SHOP_SORTS = new Set<ShopSort>(["newest", "price_asc", "price_desc", "title_asc"]);
const MAX_SHOP_PAGE = 100_000;

type SearchParamReader = Pick<URLSearchParams, "get">;

export function normalizeShopSearchParam(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function parseShopSearchParams(params: SearchParamReader): ShopBrowseState {
  const sortValue = normalizedValue(params.get("sort"));
  const pageValue = Number(normalizedValue(params.get("page")));
  return {
    search: normalizedValue(params.get("search")),
    category: normalizedValue(params.get("category")),
    collection: normalizedValue(params.get("collection")),
    sort: SHOP_SORTS.has(sortValue as ShopSort) ? (sortValue as ShopSort) : "newest",
    page: Number.isSafeInteger(pageValue) && pageValue >= 1 && pageValue <= MAX_SHOP_PAGE ? pageValue : 1,
  };
}

export function serializeShopSearchParams(state: ShopBrowseState): URLSearchParams {
  const params = new URLSearchParams();
  const search = state.search.trim();
  const category = state.category.trim();
  const collection = state.collection.trim();
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  if (collection) params.set("collection", collection);
  if (state.sort !== "newest") params.set("sort", state.sort);
  if (state.page !== 1) params.set("page", String(state.page));
  return params;
}

export function shopHref(state: ShopBrowseState): string {
  const query = serializeShopSearchParams(state).toString();
  return query ? `/shop?${query}` : "/shop";
}

export function withShopBrowseChange(
  state: ShopBrowseState,
  change: Partial<Pick<ShopBrowseState, "search" | "category" | "collection" | "sort">>,
): ShopBrowseState {
  return { ...state, ...change, page: 1 };
}

function normalizedValue(value: string | null): string {
  return value?.trim() ?? "";
}
