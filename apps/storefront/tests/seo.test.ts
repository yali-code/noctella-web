import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCanonicalUrl,
  buildEntityTitle,
  buildProductJsonLd,
  chooseDescription,
  collectAllPages,
  getStorefrontSiteUrl,
  mapAvailability,
  mapConditionToSchemaOrg,
  resolveAbsoluteImageUrl,
  safeJsonLdScript,
  shopCanonicalUrl,
  SITEMAP_STATIC_PATHS,
} from "../src/lib/seo";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("getStorefrontSiteUrl (site URL normalization and validation)", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("falls back to localhost outside production when unset", () => {
    delete process.env.STOREFRONT_SITE_URL;
    vi.stubEnv("NODE_ENV", "development");
    expect(getStorefrontSiteUrl()).toBe("http://localhost:3000");
    vi.unstubAllEnvs();
  });

  it("throws when unset in production", () => {
    delete process.env.STOREFRONT_SITE_URL;
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getStorefrontSiteUrl()).toThrow(/required in production/);
    vi.unstubAllEnvs();
  });

  it("strips a trailing slash", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com/";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("strips multiple trailing slashes", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com///";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("accepts a value with no trailing slash unchanged", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("accepts http:// as well as https://", () => {
    process.env.STOREFRONT_SITE_URL = "http://localhost:3000";
    expect(getStorefrontSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a value with no protocol (relative/bare host)", () => {
    process.env.STOREFRONT_SITE_URL = "shop.staging.noctella.com";
    expect(() => getStorefrontSiteUrl()).toThrow(/must be a valid absolute URL/);
  });

  it("rejects a non-http(s) protocol", () => {
    process.env.STOREFRONT_SITE_URL = "ftp://shop.staging.noctella.com";
    expect(() => getStorefrontSiteUrl()).toThrow(/must use http:\/\/ or https:\/\//);
  });

  it("rejects a bare 'https://' with no host", () => {
    process.env.STOREFRONT_SITE_URL = "https://";
    expect(() => getStorefrontSiteUrl()).toThrow(/must be a valid absolute URL/);
  });

  it("rejects a malformed http/https URL (truncated IPv6 host literal)", () => {
    process.env.STOREFRONT_SITE_URL = "https://[invalid-ipv6";
    expect(() => getStorefrontSiteUrl()).toThrow(/must be a valid absolute URL/);
  });

  it("removes a configured path via .origin", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com/some/path";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("removes a query string via .origin", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com/?utm=1&ref=x";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("removes a fragment via .origin", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com/#section";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("removes a path, query string, and fragment together via .origin", () => {
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com/path?x=1#frag";
    expect(getStorefrontSiteUrl()).toBe("https://shop.staging.noctella.com");
  });

  it("still rejects an unsupported protocol when a host is present", () => {
    process.env.STOREFRONT_SITE_URL = "javascript://shop.staging.noctella.com";
    expect(() => getStorefrontSiteUrl()).toThrow(/must use http:\/\/ or https:\/\//);
  });
});

describe("buildCanonicalUrl / shopCanonicalUrl (canonical URL generation)", () => {
  beforeEach(() => {
    resetEnv();
    process.env.STOREFRONT_SITE_URL = "https://shop.staging.noctella.com";
  });
  afterEach(resetEnv);

  it("builds a canonical URL for a given pathname", () => {
    expect(buildCanonicalUrl("/product/hermle-clock")).toBe(
      "https://shop.staging.noctella.com/product/hermle-clock",
    );
  });

  it("adds a leading slash if the pathname is missing one", () => {
    expect(buildCanonicalUrl("shop")).toBe("https://shop.staging.noctella.com/shop");
  });

  it("shopCanonicalUrl always returns the bare /shop path, ignoring any query-string concept entirely", () => {
    // shopCanonicalUrl() takes no query-string argument at all - it always resolves to /shop
    // regardless of whatever ?search=/?page=/?sort=/?categorySlug=/?collectionSlug= combination
    // the Shop page's own client state happens to be in.
    expect(shopCanonicalUrl()).toBe("https://shop.staging.noctella.com/shop");
  });
});

describe("buildEntityTitle (title fallback order)", () => {
  it("uses seoTitle exactly as entered when present", () => {
    expect(buildEntityTitle("Custom SEO Title | My Site", "HERMLE CLOCK")).toBe("Custom SEO Title | My Site");
  });

  it("falls back to '<name> — Noctella' when seoTitle is absent", () => {
    expect(buildEntityTitle(undefined, "HERMLE CLOCK")).toBe("HERMLE CLOCK — Noctella");
  });

  it("falls back when seoTitle is an empty/whitespace-only string", () => {
    expect(buildEntityTitle("   ", "HERMLE CLOCK")).toBe("HERMLE CLOCK — Noctella");
  });
});

describe("chooseDescription (description fallback order)", () => {
  it("prefers metaDescription when present", () => {
    expect(chooseDescription("Meta desc", "Plain desc")).toBe("Meta desc");
  });

  it("falls back to description when metaDescription is absent", () => {
    expect(chooseDescription(undefined, "Plain desc")).toBe("Plain desc");
  });

  it("falls back to the site default when both are absent", () => {
    expect(chooseDescription(undefined, undefined)).toContain("Noctella");
  });
});

describe("resolveAbsoluteImageUrl (absolute image resolution)", () => {
  beforeEach(() => {
    resetEnv();
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.staging.noctella.com";
  });
  afterEach(resetEnv);

  it("resolves a relative image path to an absolute URL", () => {
    expect(resolveAbsoluteImageUrl("/images/product-photos/x.webp")).toBe(
      "https://api.staging.noctella.com/images/product-photos/x.webp",
    );
  });

  it("returns undefined for a missing value", () => {
    expect(resolveAbsoluteImageUrl(undefined)).toBeUndefined();
    expect(resolveAbsoluteImageUrl(null)).toBeUndefined();
    expect(resolveAbsoluteImageUrl("")).toBeUndefined();
  });

  it("leaves an already-absolute URL unchanged", () => {
    expect(resolveAbsoluteImageUrl("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
  });
});

describe("mapConditionToSchemaOrg (known condition mapping)", () => {
  it("maps recognized values case-insensitively", () => {
    expect(mapConditionToSchemaOrg("New")).toBe("https://schema.org/NewCondition");
    expect(mapConditionToSchemaOrg("used")).toBe("https://schema.org/UsedCondition");
    expect(mapConditionToSchemaOrg("Refurbished")).toBe("https://schema.org/RefurbishedCondition");
    expect(mapConditionToSchemaOrg("DAMAGED")).toBe("https://schema.org/DamagedCondition");
  });

  it("omits (returns undefined for) an unrecognized free-text value rather than guessing", () => {
    expect(mapConditionToSchemaOrg("GOOD")).toBeUndefined();
    expect(mapConditionToSchemaOrg("Excellent condition, minor wear")).toBeUndefined();
  });

  it("omits when condition is absent", () => {
    expect(mapConditionToSchemaOrg(undefined)).toBeUndefined();
  });
});

describe("mapAvailability (availability only from a confirmed stock field)", () => {
  it("maps 'in_stock' to schema.org InStock", () => {
    expect(mapAvailability("in_stock")).toBe("https://schema.org/InStock");
  });

  it("maps 'out_of_stock' to schema.org OutOfStock", () => {
    expect(mapAvailability("out_of_stock")).toBe("https://schema.org/OutOfStock");
  });

  it("omits availability when no stock indicator is provided (never guesses from status)", () => {
    expect(mapAvailability()).toBeUndefined();
    expect(mapAvailability(undefined)).toBeUndefined();
  });
});

describe("buildProductJsonLd (full and partial Product JSON-LD)", () => {
  it("builds a complete JSON-LD object when every optional field is present", () => {
    const jsonLd = buildProductJsonLd({
      product: {
        title: "HERMLE CLOCK",
        description: "A fine vintage mantel clock.",
        brand: "HERMLE",
        manufacturer: "HERMLE",
        condition: "Used",
        priceEur: 120,
        status: "published" as any,
      },
      canonicalUrl: "https://shop.staging.noctella.com/product/hermle-clock",
      absoluteImageUrls: ["https://api.staging.noctella.com/images/product-photos/hermle.webp"],
    });

    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("Product");
    expect(jsonLd.name).toBe("HERMLE CLOCK");
    expect(jsonLd.description).toBe("A fine vintage mantel clock.");
    expect(jsonLd.image).toEqual(["https://api.staging.noctella.com/images/product-photos/hermle.webp"]);
    expect(jsonLd.brand).toEqual({ "@type": "Brand", name: "HERMLE" });
    expect(jsonLd.itemCondition).toBe("https://schema.org/UsedCondition");
    expect(jsonLd.offers).toMatchObject({
      "@type": "Offer",
      priceCurrency: "EUR",
      price: "120.00",
      url: "https://shop.staging.noctella.com/product/hermle-clock",
    });
    // No confirmed stock field exists on PublicProduct today, so availability is never invented.
    expect((jsonLd.offers as Record<string, unknown>).availability).toBeUndefined();
  });

  it("omits description, image, brand, itemCondition, and offers when the underlying data is absent", () => {
    const jsonLd = buildProductJsonLd({
      product: {
        title: "Untitled Object",
        description: undefined,
        brand: undefined,
        manufacturer: undefined,
        condition: undefined,
        priceEur: undefined as unknown as number,
        status: "published" as any,
      },
      canonicalUrl: "https://shop.staging.noctella.com/product/untitled-object",
      absoluteImageUrls: [],
    });

    expect(jsonLd.name).toBe("Untitled Object");
    expect(jsonLd.description).toBeUndefined();
    expect(jsonLd.image).toBeUndefined();
    expect(jsonLd.brand).toBeUndefined();
    expect(jsonLd.itemCondition).toBeUndefined();
    expect(jsonLd.offers).toBeUndefined();
  });

  it("still includes offers with a real price even when brand/condition/images are absent", () => {
    const jsonLd = buildProductJsonLd({
      product: {
        title: "Simple Object",
        description: undefined,
        brand: undefined,
        manufacturer: undefined,
        condition: undefined,
        priceEur: 42,
        status: "published" as any,
      },
      canonicalUrl: "https://shop.staging.noctella.com/product/simple-object",
      absoluteImageUrls: [],
    });

    expect(jsonLd.offers).toMatchObject({ "@type": "Offer", priceCurrency: "EUR", price: "42.00" });
    expect(jsonLd.brand).toBeUndefined();
  });

  function priceOnlyJsonLd(priceEur: number) {
    return buildProductJsonLd({
      product: {
        title: "Price Test Object",
        description: undefined,
        brand: undefined,
        manufacturer: undefined,
        condition: undefined,
        priceEur,
        status: "published" as any,
      },
      canonicalUrl: "https://shop.staging.noctella.com/product/price-test-object",
      absoluteImageUrls: [],
    });
  }

  it("priceEur = 0 still produces a real Offer with price '0.00' (zero is real data, not missing data)", () => {
    const jsonLd = priceOnlyJsonLd(0);
    expect(jsonLd.offers).toMatchObject({ "@type": "Offer", priceCurrency: "EUR", price: "0.00" });
  });

  it("omits Offer entirely for a negative price", () => {
    const jsonLd = priceOnlyJsonLd(-10);
    expect(jsonLd.offers).toBeUndefined();
  });

  it("omits Offer entirely for NaN", () => {
    const jsonLd = priceOnlyJsonLd(NaN);
    expect(jsonLd.offers).toBeUndefined();
  });

  it("omits Offer entirely for Infinity", () => {
    const jsonLd = priceOnlyJsonLd(Infinity);
    expect(jsonLd.offers).toBeUndefined();
  });
});

describe("safeJsonLdScript (safe JSON-LD serialization)", () => {
  it("escapes a </script>-closing sequence so it cannot break out of the surrounding script tag", () => {
    const serialized = safeJsonLdScript({ description: "Ends with </script><script>alert(1)</script>" });
    expect(serialized).not.toContain("</script>");
    expect(serialized).not.toContain("<script>");
    expect(serialized).toContain("\\u003c/script>");
  });

  it("produces valid JSON that round-trips back to the original data once unescaped", () => {
    const data = { a: 1, b: "safe value" };
    const serialized = safeJsonLdScript(data);
    expect(JSON.parse(serialized.replace(/\\u003c/g, "<"))).toEqual(data);
  });
});

describe("collectAllPages (sitemap pagination collection)", () => {
  it("returns an empty array for an empty catalog", async () => {
    const result = await collectAllPages(async () => ({ items: [], total: 0 }));
    expect(result).toEqual([]);
  });

  it("returns an empty array when the fetch itself fails (returns null)", async () => {
    const result = await collectAllPages(async () => null);
    expect(result).toEqual([]);
  });

  it("collects items across multiple pages until total is reached", async () => {
    const pages: Record<number, { items: number[]; total: number }> = {
      1: { items: [1, 2, 3], total: 7 },
      2: { items: [4, 5, 6], total: 7 },
      3: { items: [7], total: 7 },
    };
    const result = await collectAllPages<number>(async (page) => pages[page] ?? null);
    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("terminates instead of looping forever when total never decreases relative to collected items (malformed pagination)", async () => {
    let calls = 0;
    const result = await collectAllPages<number>(async (page) => {
      calls += 1;
      // Always claims a huge total but only ever returns one real item, then runs out.
      if (page > 3) return null;
      return { items: [page], total: 999_999 };
    });
    expect(result).toEqual([1, 2, 3]);
    expect(calls).toBe(4); // 3 real pages + 1 call that returns null and stops the loop
  });

  it("stops via the hard page cap even if the API always returns a full, non-empty page", async () => {
    const result = await collectAllPages<number>(async (page) => ({ items: [page], total: Number.MAX_SAFE_INTEGER }));
    // Bounded by the internal MAX_SITEMAP_PAGES safety cap - proves this can never truly loop forever.
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("sitemap SITEMAP_STATIC_PATHS (exclusion of private/transactional URLs)", () => {
  it("includes the expected public static routes", () => {
    expect(SITEMAP_STATIC_PATHS).toEqual(expect.arrayContaining(["/", "/shop", "/categories", "/collections", "/archive", "/about"]));
  });

  it("never includes cart, wishlist, checkout, or account routes", () => {
    for (const privatePath of ["/cart", "/wishlist", "/checkout", "/account"]) {
      expect(SITEMAP_STATIC_PATHS).not.toContain(privatePath);
    }
  });
});
