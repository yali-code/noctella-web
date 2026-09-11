export type TaxonomyRoute = "category" | "collection";

const MAX_TAXONOMY_PAGE = 10_000;

export function normalizeTaxonomyPage(value: string | string[] | undefined): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !/^\d+$/.test(candidate)) return 1;

  const page = Number(candidate);
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_TAXONOMY_PAGE ? page : 1;
}

export function taxonomyBrowseHref(route: TaxonomyRoute, slug: string, page: number): string {
  const pathname = `/${route}/${encodeURIComponent(slug)}`;
  return page > 1 ? `${pathname}?page=${page}` : pathname;
}
