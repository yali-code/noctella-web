import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storefrontHeaderNavItems as NAV_ITEMS } from "../src/config/nav";

const APP_DIR = path.resolve(__dirname, "../src/app");

/**
 * Dynamic App Router segments (e.g. /category/gentleman-series) don't map 1:1 onto a filesystem
 * path - the route is served by a [slug] page. This maps each known dynamic href prefix to the
 * page file that actually serves it, so the contract check below can verify a real file exists
 * for every nav item, static or dynamic.
 */
const DYNAMIC_ROUTE_BASES: Array<{ prefix: string; pageFile: string }> = [
  { prefix: "/category/", pageFile: "category/[slug]/page.tsx" },
  { prefix: "/collection/", pageFile: "collection/[slug]/page.tsx" },
  { prefix: "/product/", pageFile: "product/[slug]/page.tsx" },
];

function resolvePageFileForHref(href: string): string {
  const dynamicMatch = DYNAMIC_ROUTE_BASES.find((route) => href.startsWith(route.prefix));
  if (dynamicMatch) return dynamicMatch.pageFile;
  const segments = href.split("/").filter(Boolean);
  return segments.length === 0 ? "page.tsx" : path.join(...segments, "page.tsx");
}

describe("Header navigation contract", () => {
  it("includes a Categories item pointing at /categories", () => {
    const categoriesItem = NAV_ITEMS.find((item) => item.label === "Categories");
    expect(categoriesItem?.href).toBe("/categories");
  });

  it.each(NAV_ITEMS)("nav item $label ($href) resolves to a real App Router page file", ({ href }) => {
    const pageFile = resolvePageFileForHref(href);
    const fullPath = path.join(APP_DIR, pageFile);
    expect(fs.existsSync(fullPath)).toBe(true);
  });
});
