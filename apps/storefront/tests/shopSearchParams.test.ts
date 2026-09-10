import { describe, expect, it } from "vitest";
import {
  parseShopSearchParams,
  normalizeShopSearchParam,
  serializeShopSearchParams,
  shopHref,
  withShopBrowseChange,
} from "../src/lib/shopSearchParams";

describe("normalizeShopSearchParam", () => {
  it("returns an empty string when the value is missing (null)", () => {
    expect(normalizeShopSearchParam(null)).toBe("");
  });

  it("returns an empty string when the value is undefined", () => {
    expect(normalizeShopSearchParam(undefined)).toBe("");
  });

  it("returns an empty string when the value is already an empty string", () => {
    expect(normalizeShopSearchParam("")).toBe("");
  });

  it("returns the value unchanged for a normal search term", () => {
    expect(normalizeShopSearchParam("clock")).toBe("clock");
  });

  it("passes through an already-decoded value containing special characters unchanged", () => {
    // URLSearchParams.get() decodes percent-encoding before this helper ever sees the value -
    // this asserts the helper never re-encodes or mangles that already-decoded value.
    expect(normalizeShopSearchParam("hermle & sons")).toBe("hermle & sons");
  });

  it("uses the first value when given a repeated-parameter array (?search=a&search=b)", () => {
    expect(normalizeShopSearchParam(["first", "second"])).toBe("first");
  });

  it("returns an empty string for an empty repeated-parameter array", () => {
    expect(normalizeShopSearchParam([])).toBe("");
  });
});

describe("shop browse URL state", () => {
  it("parses supported values and trims strings", () => {
    expect(parseShopSearchParams(new URLSearchParams("search=%20clock%20&category=timepieces&collection=icons&sort=price_desc&page=3"))).toEqual({
      search: "clock", category: "timepieces", collection: "icons", sort: "price_desc", page: 3,
    });
  });

  it("falls back for invalid sort and bounded page values", () => {
    for (const query of ["sort=relevance&page=0", "page=-1", "page=1.5", "page=100001", "page=unsafe"]) {
      expect(parseShopSearchParams(new URLSearchParams(query))).toMatchObject({ sort: "newest", page: 1 });
    }
  });

  it("uses the first repeated parameter value", () => {
    expect(parseShopSearchParams(new URLSearchParams("category=first&category=second")).category).toBe("first");
  });

  it("omits defaults and serializes recognized values in stable order", () => {
    const state = { search: " clock ", category: "time", collection: "icons", sort: "title_asc" as const, page: 2 };
    expect(serializeShopSearchParams(state).toString()).toBe("search=clock&category=time&collection=icons&sort=title_asc&page=2");
    expect(shopHref({ search: "", category: "", collection: "", sort: "newest", page: 1 })).toBe("/shop");
  });

  it("resets page for committed search, filter, and sort changes", () => {
    expect(withShopBrowseChange({ search: "", category: "", collection: "", sort: "newest", page: 8 }, { category: "clocks" }))
      .toEqual({ search: "", category: "clocks", collection: "", sort: "newest", page: 1 });
  });
});
