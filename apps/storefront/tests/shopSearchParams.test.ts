import { describe, expect, it } from "vitest";
import { normalizeShopSearchParam } from "../src/lib/shopSearchParams";

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
