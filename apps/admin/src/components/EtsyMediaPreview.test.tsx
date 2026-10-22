// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { EtsyMediaPreview } from "./EtsyMediaPreview";
import { resolveApiAssetUrl } from "@/lib/api";
import { buildEtsyMediaPlan, type EtsyPhotoCandidate } from "@/lib/etsyMediaPlan";

const photo = (id: string, overrides: Partial<EtsyPhotoCandidate> = {}): EtsyPhotoCandidate => ({
  id, url: `/images/${id}.webp`, thumbnailUrl: `/images/${id}-thumb.webp`,
  sortOrder: 0, isPrimary: false, altText: `Object ${id}`, processingStatus: "Ready", ...overrides,
});
afterEach(() => vi.restoreAllMocks());
const preview = () => screen.getByRole("region", { name: "Etsy Media Preview" });

describe("EtsyMediaPreview", () => {
  it("shows primary-first stable ranks from the existing selector without mutating canonical photos", () => {
    const photos = Object.freeze([Object.freeze(photo("b")), Object.freeze(photo("p", { isPrimary: true, sortOrder: 99 })), Object.freeze(photo("a"))]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No requests allowed"));
    render(<EtsyMediaPreview photos={photos} />);
    expect(screen.getByRole("heading", { name: "Etsy Media Preview", level: 2 })).toBeInTheDocument();
    expect(within(preview()).getByRole("status")).toHaveTextContent("Eligible for media preview");
    const items = within(screen.getByRole("list", { name: "Etsy candidate images" })).getAllByRole("listitem");
    expect(items.map(item => within(item).getByRole("img").getAttribute("alt"))).toEqual(["Object p", "Object a", "Object b"]);
    expect(items[0]).toHaveTextContent("Etsy rank 1 — Primary image");
    expect(within(items[0]).getByRole("img")).toHaveAttribute("src", resolveApiAssetUrl("/images/p-thumb.webp"));
    expect(photos.map(p => p.id)).toEqual(["b", "p", "a"]);
    expect(buildEtsyMediaPlan(photos).media.map(p => p.photoId)).toEqual(["p", "a", "b"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(within(preview()).queryByRole("button")).not.toBeInTheDocument();
    expect(preview()).toHaveTextContent("Read only — not published or synced to Etsy.");
    expect(preview()).toHaveTextContent("full publishing readiness are checked separately");
    expect(preview()).not.toHaveTextContent("Ready to Publish");
  });

  it("shows loading and failed reads without stale eligibility or images", () => {
    const photos = [photo("a", { isPrimary: true })];
    const { rerender } = render(<EtsyMediaPreview photos={photos} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Etsy media preview");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    rerender(<EtsyMediaPreview photos={photos} error />);
    expect(screen.getByRole("alert")).toHaveTextContent("preview unavailable");
    expect(screen.queryByText("Eligible for media preview")).not.toBeInTheDocument();
  });

  it("provides an empty state and missing-primary warning", () => {
    render(<EtsyMediaPreview photos={[]} />);
    expect(preview()).toHaveTextContent("No canonical photos yet");
    expect(screen.getByRole("list", { name: "Etsy media warnings" })).toHaveTextContent("No eligible primary image");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each(["Processing", "Failed"] as const)("excludes a %s primary and reports lack of a Ready primary", processingStatus => {
    render(<EtsyMediaPreview photos={[photo("bad", { isPrimary: true, processingStatus }), photo("ready")]} />);
    expect(preview()).toHaveTextContent("1 Processing, Failed, or unclassified photo(s) excluded");
    expect(preview()).toHaveTextContent("No eligible primary image");
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("needs attention");
  });

  it("warns on multiple primaries", () => {
    render(<EtsyMediaPreview photos={[photo("a", { isPrimary: true }), photo("b", { isPrimary: true })]} />);
    expect(preview()).toHaveTextContent("Multiple eligible primary images");
    expect(screen.getByRole("status")).toHaveTextContent("needs attention");
  });

  it("fails closed on duplicate identities and never exposes storage metadata", () => {
    const photos = [photo("a", { isPrimary: true }), { ...photo("a"), storageKey: "private/object-key", processingErrorCode: "internal/path" }];
    render(<EtsyMediaPreview photos={photos} />);
    expect(preview()).toHaveTextContent("Duplicate photo identities");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(preview().innerHTML).not.toMatch(/private\/object-key|internal\/path/);
  });

  it("excludes missing/unsafe image URLs and unsafe thumbnails without echoing them", () => {
    render(<EtsyMediaPreview photos={[
      photo("primary", { isPrimary: true }), photo("missing", { url: "" }),
      photo("unsafe", { url: "https://secret:password@example.test/private" }),
      photo("thumb", { thumbnailUrl: "javascript:alert(1)" }),
    ]} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(preview()).toHaveTextContent("3 photo(s) excluded");
    expect(preview()).toHaveTextContent("URL is unsafe");
    expect(preview().innerHTML).not.toMatch(/secret|password|javascript:/);
  });

  it.each([20, 21, 50])("shows at most 20 of %i eligible images without altering the source", count => {
    const photos = Array.from({ length: count }, (_, i) => photo(`photo-${i}`, { sortOrder: i, isPrimary: i === 0 }));
    render(<EtsyMediaPreview photos={photos} />);
    expect(screen.getAllByRole("img")).toHaveLength(20);
    expect(preview()).toHaveTextContent("Etsy rank 20");
    expect(preview()).not.toHaveTextContent("Etsy rank 21");
    if (count > 20) expect(preview()).toHaveTextContent(`${count - 20} eligible photo(s) exceed`);
    else expect(preview()).not.toHaveTextContent("exceed Etsy's");
    expect(photos).toHaveLength(count);
  });

  it("counts Unicode code points, warns on missing/501-character alt text, and falls back to the safe full image", () => {
    const unicode = "\u{1F642}".repeat(500);
    render(<EtsyMediaPreview photos={[
      photo("a", { isPrimary: true, altText: unicode, thumbnailUrl: "" }),
      photo("b", { altText: unicode + "\u{1F642}" }), photo("c", { altText: "" }),
    ]} />);
    const list = screen.getByRole("list", { name: "Etsy candidate images" });
    const items = within(list).getAllByRole("listitem").filter(item => item.parentElement === list);
    expect(items[0]).toHaveTextContent("500 / 500 Unicode code points");
    expect(within(items[0]).getByRole("img")).toHaveAttribute("src", resolveApiAssetUrl("/images/a.webp"));
    expect(items[0]).not.toHaveTextContent("exceeding");
    expect(items[1]).toHaveTextContent("501 / 500");
    expect(within(items[1]).getByRole("list", { name: "Warnings for Etsy rank 2" })).toHaveTextContent("exceeding 500");
    expect(items[2].querySelector("img")).toHaveAttribute("alt", "");
    expect(items[2]).toHaveTextContent("missing alt text");
  });
});
