import { describe, expect, it } from "vitest";
import { resolveServiceUrl } from "@noctella/shared";
import { primaryProductImage, productThumbnailUrl, sortedProductImages } from "./productImages";

describe("storefront product image selection", () => {
  const legacy = [{ id: "legacy", url: "/legacy.jpg", sortOrder: 0, isPrimary: true }];
  const photos = [
    { id: "secondary", url: "/secondary.webp", thumbnailUrl: "/secondary-thumb.webp", sortOrder: 0, isPrimary: false },
    { id: "primary", url: "/primary.webp", thumbnailUrl: "/primary-thumb.webp", sortOrder: 1, isPrimary: true },
  ];

  it("prefers product photos over legacy images", () => {
    expect(primaryProductImage({ photos, images: legacy })?.id).toBe("primary");
  });

  it("sorts primary image first and falls back to legacy images", () => {
    expect(sortedProductImages({ photos }).map((image) => image.id)).toEqual(["primary", "secondary"]);
    expect(primaryProductImage({ images: legacy })?.id).toBe("legacy");
  });

  it("uses thumbnails when available", () => {
    expect(productThumbnailUrl(photos[0])).toBe("/secondary-thumb.webp");
    expect(productThumbnailUrl(legacy[0])).toBe("/legacy.jpg");
  });

  // Sprint 70: the image-selection accessors above must keep returning the API's raw, portable
  // relative URL - never a resolved absolute one - since this same value is what gets written
  // into cart localStorage / checkout drafts (see app/product/[slug]/page.tsx's
  // addToCartPersisted call). Resolution only happens at render time (ProductCard/ProductGallery
  // and the cart/checkout/review pages), never here.
  it("keeps the relative URL unresolved - safe to persist into cart/checkout storage as-is", () => {
    expect(primaryProductImage({ photos, images: legacy })?.url).toBe("/primary.webp");
    expect(productThumbnailUrl(photos[1])).toBe("/primary-thumb.webp");
  });
});

describe("resolveServiceUrl (Sprint 70)", () => {
  const baseUrl = "http://localhost:4000";

  it("resolves a relative URL with a leading slash", () => {
    expect(resolveServiceUrl("/images/example.webp", baseUrl)).toBe("http://localhost:4000/images/example.webp");
  });

  it("resolves a relative URL without a leading slash", () => {
    expect(resolveServiceUrl("images/example.webp", baseUrl)).toBe("http://localhost:4000/images/example.webp");
  });

  it("resolves correctly when the base URL has a trailing slash, without producing a double slash", () => {
    expect(resolveServiceUrl("/images/example.webp", "http://localhost:4000/")).toBe(
      "http://localhost:4000/images/example.webp",
    );
    expect(resolveServiceUrl("images/example.webp", "http://localhost:4000/")).toBe(
      "http://localhost:4000/images/example.webp",
    );
  });

  it("leaves an https:// URL unchanged", () => {
    expect(resolveServiceUrl("https://cdn.example.com/photo.webp", baseUrl)).toBe(
      "https://cdn.example.com/photo.webp",
    );
  });

  it("leaves an http:// URL unchanged", () => {
    expect(resolveServiceUrl("http://cdn.example.com/photo.webp", baseUrl)).toBe("http://cdn.example.com/photo.webp");
  });

  it("leaves a protocol-relative //cdn URL unchanged", () => {
    expect(resolveServiceUrl("//cdn.example.com/photo.webp", baseUrl)).toBe("//cdn.example.com/photo.webp");
  });

  it("leaves a data: URI unchanged", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveServiceUrl(dataUri, baseUrl)).toBe(dataUri);
  });

  it("leaves a blob: URL unchanged", () => {
    const blobUrl = "blob:http://localhost:3000/2f4b1c3a-1234-5678-9abc-def012345678";
    expect(resolveServiceUrl(blobUrl, baseUrl)).toBe(blobUrl);
  });

  it("safely handles an empty string", () => {
    expect(resolveServiceUrl("", baseUrl)).toBe("");
  });

  it("safely handles undefined", () => {
    expect(resolveServiceUrl(undefined, baseUrl)).toBe("");
  });

  it("safely handles null", () => {
    expect(resolveServiceUrl(null, baseUrl)).toBe("");
  });

  it("never produces a double slash for any relative/base combination", () => {
    for (const value of ["/images/example.webp", "images/example.webp"]) {
      for (const base of ["http://localhost:4000", "http://localhost:4000/"]) {
        expect(resolveServiceUrl(value, base)).not.toMatch(/[^:]\/\//);
      }
    }
  });

  it("does not normalize or rewrite an already-absolute URL", () => {
    const withTrailingSlash = "https://cdn.example.com/photo.webp/";
    expect(resolveServiceUrl(withTrailingSlash, baseUrl)).toBe(withTrailingSlash);
  });
});
