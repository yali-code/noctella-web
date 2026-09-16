import { describe, expect, it } from "vitest";
import { PublicRuntimeConfigurationError, resolvePublicApiBaseUrl } from "@noctella/shared";
import { resolveStorefrontSiteUrl } from "./seo";

describe("Packet I public runtime configuration", () => {
  it("preserves localhost defaults outside production", () => {
    expect(resolvePublicApiBaseUrl(undefined, "development")).toBe("http://localhost:4000");
    expect(resolveStorefrontSiteUrl(undefined, "test")).toBe("http://localhost:3000");
  });

  it("requires explicit browser-visible origins in production", () => {
    expect(() => resolvePublicApiBaseUrl(undefined, "production")).toThrow(PublicRuntimeConfigurationError);
    expect(() => resolveStorefrontSiteUrl(undefined, "production")).toThrow(/required in production/);
  });

  it.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://api.example.test",
    "https://user:secret@api.example.test",
    "https://api.example.test/path",
  ])("rejects an unsafe production API URL: %s", (value) => {
    expect(() => resolvePublicApiBaseUrl(value, "production")).toThrow(PublicRuntimeConfigurationError);
  });

  it.each(["http://localhost:3000", "http://storefront.example.test", "http://127.0.0.1:3000"])(
    "rejects an unsafe production Storefront origin: %s",
    (value) => expect(() => resolveStorefrontSiteUrl(value, "production")).toThrow(/non-local HTTPS origin/),
  );

  it("normalizes safe production origins", () => {
    expect(resolvePublicApiBaseUrl(" https://api.example.test ", "production")).toBe("https://api.example.test");
    expect(resolveStorefrontSiteUrl("https://shop.example.test/catalog?ignored=true", "production")).toBe("https://shop.example.test");
  });

  it("does not echo malformed configured values in diagnostics", () => {
    const malformed = "not-a-url-containing-secret";
    for (const operation of [
      () => resolvePublicApiBaseUrl(malformed, "production"),
      () => resolveStorefrontSiteUrl(malformed, "production"),
    ]) {
      try { operation(); } catch (error) {
        expect(String(error)).not.toContain(malformed);
        continue;
      }
      throw new Error("Expected malformed public configuration to fail");
    }
  });
});
