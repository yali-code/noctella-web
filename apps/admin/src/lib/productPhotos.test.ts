import { describe, expect, it } from "vitest";
import { productPhotoCapabilities, productPhotoPublicationReadiness, productPhotoUploadForm, reorderProductPhotoIds } from "./productPhotos";

describe("admin product photo helpers", () => {
  it("builds multipart upload form data", async () => {
    const file = new File(["photo"], "lamp.png", { type: "image/png" });
    const form = productPhotoUploadForm(file, "Front view");
    expect(form.get("photo")).toBe(file);
    expect(form.get("altText")).toBe("Front view");
  });

  it("creates a complete, bounded reorder without mutating source photos", () => {
    const photos = [{ id: "a" }, { id: "b" }, { id: "c" }] as any;
    expect(reorderProductPhotoIds(photos, "b", -1)).toEqual(["b", "a", "c"]);
    expect(photos.map((photo: { id: string }) => photo.id)).toEqual(["a", "b", "c"]);
    expect(reorderProductPhotoIds(photos, "a", -1)).toBeNull();
  });

  it("derives photo actions from canonical order and primary state", () => {
    const photos = [{ id: "a", isPrimary: true }, { id: "b", isPrimary: false }] as any;
    expect(productPhotoCapabilities(photos, "a")).toEqual({ canMoveEarlier: false, canMoveLater: true, canSetPrimary: false, canDelete: true });
    expect(productPhotoCapabilities(photos, "b").canSetPrimary).toBe(true);
  });
});

describe("productPhotoPublicationReadiness", () => {
  it("requires a ready resolved primary and reports missing alt text", () => {
    expect(productPhotoPublicationReadiness([
      { id: "a", processingStatus: "Ready", url: "/a", isPrimary: true, altText: "" },
      { id: "b", processingStatus: "Failed", url: "/b", isPrimary: false, altText: "ignored" },
    ] as any)).toEqual({ ready: true, readyPhotoCount: 1, hasPrimary: true, missingAltTextCount: 1 });
  });
});
