import { describe, expect, it } from "vitest";
import { productPhotoUploadForm } from "./productPhotos";

describe("admin product photo helpers", () => {
  it("builds multipart upload form data", async () => {
    const file = new File(["photo"], "lamp.png", { type: "image/png" });
    const form = productPhotoUploadForm(file, "Front view");
    expect(form.get("photo")).toBe(file);
    expect(form.get("altText")).toBe("Front view");
  });
});
