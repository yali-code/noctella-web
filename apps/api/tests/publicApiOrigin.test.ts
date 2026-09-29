import { expect, it } from "vitest";
import { resolvePublicApiOrigin } from "../src/config/publicApiOrigin";

it.each(["https://api.example.test", "https://api.example.test/", "  https://API.EXAMPLE.TEST/  "])("canonicalizes %s", (value) => {
  expect(resolvePublicApiOrigin({ PUBLIC_API_ORIGIN: value })).toBe("https://api.example.test");
});

it.each([
  undefined, "", "   ", "not-a-url", "//api.example.test", "https:api.example.test",
  "http://api.example.test", "http://localhost:4000", "ftp://api.example.test",
  "https://user:secret@api.example.test", "https://@api.example.test",
  "https://api.example.test?token=secret", "https://api.example.test?",
  "https://api.example.test#secret", "https://api.example.test#",
  "https://api.example.test/images", "https://api.example.test/.", "https://api.example.test/a/..",
  "https://api.example.test\\images",
])("rejects invalid origin %j without echoing it", (value) => {
  expect(() => resolvePublicApiOrigin({ PUBLIC_API_ORIGIN: value })).toThrow(
    "Invalid configuration: PUBLIC_API_ORIGIN must be an HTTPS origin without credentials, path, query or fragment",
  );
});

it("does not fall back to frontend configuration or header-like values", () => {
  expect(() => resolvePublicApiOrigin({
    ADMIN_APP_ORIGIN: "https://api.example.test", STOREFRONT_APP_ORIGIN: "https://api.example.test",
    NEXT_PUBLIC_API_BASE_URL: "https://api.example.test", Host: "api.example.test",
    Origin: "https://api.example.test", "X-Forwarded-Host": "api.example.test",
  })).toThrow("Invalid configuration: PUBLIC_API_ORIGIN");
});
