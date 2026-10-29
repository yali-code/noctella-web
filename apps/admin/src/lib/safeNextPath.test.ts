import { describe, expect, it } from "vitest";
import { safeNextPath } from "./auth";

describe("safeNextPath (SEC-A1)", () => {
  it("rejects a literal backslash used to smuggle a host", () => {
    expect(safeNextPath("/\\evil.example.com")).toBe("/");
  });

  it("rejects a backslash-then-slash variant", () => {
    expect(safeNextPath("/\\/evil.example.com")).toBe("/");
  });

  it("leaves a percent-encoded backslash (%5C) as a literal path segment - browsers do not decode it before navigation, so it is not a host-smuggling vector here", () => {
    expect(safeNextPath("/%5Cevil.example.com")).toBe("/%5Cevil.example.com");
  });

  it("rejects an embedded tab control character", () => {
    expect(safeNextPath("/\tevil")).toBe("/");
  });

  it("still allows an ordinary relative path with a query string", () => {
    expect(safeNextPath("/products/p1?x=1")).toBe("/products/p1?x=1");
  });
});
