import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Vitest discovery configuration (Sprint 53B)", () => {
  it("F: excludes tests/build-copy.test.mjs (node:test file) from Vitest discovery", () => {
    const source = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
    expect(source).toContain("tests/build-copy.test.mjs");
    expect(source).toContain("defaultExclude");
  });
});
