import { describe, expect, it } from "vitest";
import { buildEtsyMediaPlan, type EtsyPhotoCandidate } from "./etsyMediaPlan";

function photo(id: string, overrides: Partial<EtsyPhotoCandidate> = {}): EtsyPhotoCandidate {
  return { id, url: "/images/product-photos/" + id + ".webp", thumbnailUrl: "/images/product-photos/" + id + "-thumb.webp", sortOrder: Number(id.replace(/\D/g, "")) || 0, isPrimary: false, processingStatus: "Ready", altText: "Object " + id, ...overrides };
}

describe("read-only Etsy media plan", () => {
  it("blocks empty images and missing explicit primary", () => {
    expect(buildEtsyMediaPlan([])).toMatchObject({ ready: false, media: [], eligibleCount: 0 });
    const plan = buildEtsyMediaPlan([photo("1")]);
    expect(plan.ready).toBe(false);
    expect(plan.issues).toContainEqual({ code: "MISSING_PRIMARY" });
  });

  it("places Ready primary first regardless of canonical sort order, stabilizes sort ties, and never mutates frozen inputs", () => {
    const data = Object.freeze([
      Object.freeze(photo("b", { sortOrder: 4 })),
      Object.freeze(photo("p", { sortOrder: 99, isPrimary: true })),
      Object.freeze(photo("a", { sortOrder: 4 })),
    ]);
    const plan = buildEtsyMediaPlan(data);
    expect(plan.ready).toBe(true);
    expect(plan.media.map(p => [p.photoId, p.etsyRank])).toEqual([["p", 1], ["a", 2], ["b", 3]]);
    expect(data.map(p => p.id)).toEqual(["b", "p", "a"]);
    expect(plan.media[0].sourceSortOrder).toBe(99);
  });

  it("does not treat a Processing or Failed primary as externally attachable", () => {
    for (const processingStatus of ["Processing", "Failed"] as const) {
      const plan = buildEtsyMediaPlan([photo("primary", { isPrimary: true, processingStatus }), photo("ready")]);
      expect(plan.ready).toBe(false);
      expect(plan.media.map(x => x.photoId)).toEqual(["ready"]);
      expect(plan.issues).toContainEqual({ code: "MISSING_PRIMARY" });
    }
  });

  it("ignores Ready entries with no URL; only Ready candidates count", () => {
    const plan = buildEtsyMediaPlan([photo("1", { isPrimary: true, url: " " }), photo("2"), photo("3", { processingStatus: "Processing" })]);
    expect(plan.eligibleCount).toBe(1);
    expect(plan.ready).toBe(false);
    expect(plan.issues).toContainEqual({ code: "EXCLUDED_INCOMPLETE", count: 2 });
  });

  it("fails closed on multiple primary flags and duplicate IDs", () => {
    const multiple = buildEtsyMediaPlan([photo("1", { isPrimary: true }), photo("2", { isPrimary: true })]);
    expect(multiple.ready).toBe(false);
    expect(multiple.issues).toContainEqual({ code: "MULTIPLE_PRIMARIES", count: 2 });
    const duplicate = buildEtsyMediaPlan([photo("x", { isPrimary: true }), photo("x")]);
    expect(duplicate.ready).toBe(false);
    expect(duplicate.issues).toContainEqual({ code: "DUPLICATE_PHOTO_ID" });
  });

  it("caps only the provider-facing candidate plan at 20 and retains source photos", () => {
    const data = Array.from({ length: 50 }, (_, i) => photo(String(i + 1), { isPrimary: i === 49 }));
    const plan = buildEtsyMediaPlan(data);
    expect(plan.media).toHaveLength(20);
    expect(plan.eligibleCount).toBe(50);
    expect(plan.truncatedCount).toBe(30);
    expect(plan.media[0].photoId).toBe("50");
    expect(plan.issues).toContainEqual({ code: "IMAGE_LIMIT", count: 30 });
    expect(data).toHaveLength(50);
    expect(buildEtsyMediaPlan(data.slice(0, 20)).truncatedCount).toBe(0);
    expect(buildEtsyMediaPlan(data.slice(0, 21)).truncatedCount).toBe(1);
  });

  it("reports alt text warnings without modifying or silently truncating Unicode", () => {
    const fiveHundred = "🙂".repeat(500);
    const plan = buildEtsyMediaPlan([
      photo("1", { isPrimary: true, altText: fiveHundred }),
      photo("2", { altText: fiveHundred + "🙂" }),
      photo("3", { altText: "   " }),
    ]);
    expect(plan.media[0].altTextLength).toBe(500);
    expect(plan.media[0].warnings).toEqual([]);
    expect(plan.media[1].altTextLength).toBe(501);
    expect(plan.media[1].altText).toBe(fiveHundred + "🙂");
    expect(plan.media[1].warnings).toContain("ALT_TEXT_TOO_LONG");
    expect(plan.media[2].warnings).toContain("MISSING_ALT_TEXT");
  });

  it("excludes potentially unsafe display URLs without exposing storage keys", () => {
    const plan = buildEtsyMediaPlan([
      photo("safe", { isPrimary: true, url: "https://photos.example.test/photo.webp" }),
      photo("evil", { url: "javascript:alert(1)" }),
      photo("protocol", { url: "//other.test/pic" }),
      photo("credentials", { url: "https://user:pass@other.test/pic" }),
    ]);
    expect(plan.media.map(p => p.photoId)).toEqual(["safe"]);
    expect(plan.ready).toBe(true);
    expect(plan.issues.filter(i => i.code === "UNSAFE_IMAGE_URL")).toHaveLength(3);
    expect(JSON.stringify(plan)).not.toContain("storageKey");
  });
});
