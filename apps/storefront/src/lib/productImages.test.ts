import { describe, expect, it } from "vitest";
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
});
