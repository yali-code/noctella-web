import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sitemap from "../src/app/sitemap";

interface ProductFixture {
  slug: string;
  updatedAt?: string;
}

const ORIGINAL_ENV = { ...process.env };

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

function installPublicFetch({
  activePages = { 1: { items: [], total: 0 } },
  archivePages = { 1: { items: [], total: 0 } },
  archiveFailure = false,
}: {
  activePages?: Record<number, { items: ProductFixture[]; total: number }>;
  archivePages?: Record<number, { items: ProductFixture[]; total: number }>;
  archiveFailure?: boolean;
} = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/public/categories") {
      return response({ items: [{ slug: "watches" }] });
    }
    if (url.pathname === "/api/public/collections") {
      return response({ items: [{ slug: "night-sky" }] });
    }
    if (url.pathname === "/api/public/products/archive") {
      if (archiveFailure) throw new Error("Archive unavailable");
      const page = Number(url.searchParams.get("page"));
      return response(archivePages[page] ?? { items: [], total: 0 });
    }
    if (url.pathname === "/api/public/products") {
      const page = Number(url.searchParams.get("page"));
      return response(activePages[page] ?? { items: [], total: 0 });
    }
    throw new Error(`Unexpected public fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Sprint 155 archival Sold sitemap discoverability", () => {
  beforeEach(() => {
    process.env.STOREFRONT_SITE_URL = "https://shop.test.noctella.com";
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.test.noctella.com";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("includes active and authoritative archive products in the same sitemap", async () => {
    const fetchMock = installPublicFetch({
      activePages: { 1: { items: [{ slug: "active-clock", updatedAt: "2026-08-01T00:00:00.000Z" }], total: 1 } },
      archivePages: { 1: { items: [{ slug: "sold-camera", updatedAt: "2026-08-02T00:00:00.000Z" }], total: 1 } },
    });

    const result = await sitemap();
    const urls = result.map((entry) => entry.url);
    expect(urls).toContain("https://shop.test.noctella.com/product/active-clock");
    expect(urls).toContain("https://shop.test.noctella.com/product/sold-camera");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/public/products/archive?page=1&pageSize=100"))).toBe(true);
  });

  it("collects archival products from later pages", async () => {
    const fetchMock = installPublicFetch({
      archivePages: {
        1: { items: [{ slug: "sold-page-one" }], total: 2 },
        2: { items: [{ slug: "sold-page-two" }], total: 2 },
      },
    });

    const result = await sitemap();
    expect(result.map((entry) => entry.url)).toEqual(expect.arrayContaining([
      "https://shop.test.noctella.com/product/sold-page-one",
      "https://shop.test.noctella.com/product/sold-page-two",
    ]));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/public/products/archive?page=2&pageSize=100"))).toBe(true);
  });

  it("preserves active, static, category, and collection entries when the archive is empty", async () => {
    installPublicFetch({
      activePages: { 1: { items: [{ slug: "active-object" }], total: 1 } },
    });

    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toEqual(expect.arrayContaining([
      "https://shop.test.noctella.com/",
      "https://shop.test.noctella.com/archive",
      "https://shop.test.noctella.com/category/watches",
      "https://shop.test.noctella.com/collection/night-sky",
      "https://shop.test.noctella.com/product/active-object",
    ]));
    const productPaths = urls
      .map((url) => new URL(url).pathname)
      .filter((pathname) => pathname.startsWith("/product/"));
    expect(productPaths).toEqual(["/product/active-object"]);
  });

  it("preserves the non-archive sitemap when archive fetching fails", async () => {
    installPublicFetch({
      activePages: { 1: { items: [{ slug: "still-active" }], total: 1 } },
      archiveFailure: true,
    });

    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain("https://shop.test.noctella.com/product/still-active");
    expect(urls).toContain("https://shop.test.noctella.com/archive");
    expect(urls).toContain("https://shop.test.noctella.com/category/watches");
    expect(urls).toContain("https://shop.test.noctella.com/collection/night-sky");
  });

  it("deduplicates product entries by final canonical URL", async () => {
    installPublicFetch({
      activePages: { 1: { items: [{ slug: "shared-object" }, { slug: "shared-object" }], total: 2 } },
      archivePages: { 1: { items: [{ slug: "shared-object" }], total: 1 } },
    });

    const canonical = "https://shop.test.noctella.com/product/shared-object";
    expect((await sitemap()).filter((entry) => entry.url === canonical)).toHaveLength(1);
  });

  it("uses real archival updatedAt as lastModified and never fabricates a missing value", async () => {
    installPublicFetch({
      archivePages: {
        1: {
          items: [
            { slug: "dated-sold-object", updatedAt: "2026-08-03T04:05:06.000Z" },
            { slug: "undated-sold-object" },
          ],
          total: 2,
        },
      },
    });

    const result = await sitemap();
    const dated = result.find((entry) => entry.url.endsWith("/product/dated-sold-object"));
    const undated = result.find((entry) => entry.url.endsWith("/product/undated-sold-object"));
    expect(dated?.lastModified).toEqual(new Date("2026-08-03T04:05:06.000Z"));
    expect(undated).not.toHaveProperty("lastModified");
  });

  it("does not introduce private or transactional sitemap routes", async () => {
    installPublicFetch();
    const urls = (await sitemap()).map((entry) => new URL(entry.url).pathname);
    for (const privatePath of ["/cart", "/wishlist", "/checkout", "/account"]) {
      expect(urls).not.toContain(privatePath);
    }
  });
});
