// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArchivePage from "@/app/archive/page";
import ProductPage, { generateMetadata } from "@/app/product/[slug]/page";
import { ProductDetailClient } from "@/app/product/[slug]/ProductDetailClient";
import { api, ApiError } from "@/lib/api";
import type { PublicProductDetail } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

const soldProduct: PublicProductDetail = {
  id: "sold-154c",
  slug: "archival-brass-clock",
  title: "Archival Brass Clock",
  type: "unique_item",
  shortDescription: "A documented object from the interwar period.",
  description: "The original dial and case remain together.",
  productStory: "Preserved as a reference after finding its next home.",
  manufacturer: "Maison Nocturne",
  countryOfOrigin: "France",
  period: "1930s",
  materials: "Brass and glass",
  lengthValue: 20,
  widthValue: 12,
  heightValue: 30,
  dimensionUnit: "cm",
  weightValue: 2.5,
  weightUnit: "kg",
  condition: "Very good",
  conditionDescription: "Light age-consistent surface wear.",
  priceEur: 125,
  shippingNote: "Historical listing information.",
  customsWarning: false,
  isFeatured: false,
  allowMakeOffer: true,
  allowCashOnDelivery: true,
  status: "sold",
  images: [{ id: "image-1", url: "/clock.webp", altText: "Brass clock", sortOrder: 0, isPrimary: true }],
  relatedProducts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

describe("Sprint 154C sold and archive behavior", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.get).mockReset().mockResolvedValue(soldProduct as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => soldProduct,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders sold PDP reference content while suppressing commerce and wishlist controls", async () => {
    localStorage.setItem("noctella_cart", JSON.stringify([{ productId: soldProduct.id, quantity: 1 }]));
    render(<ProductDetailClient slug={soldProduct.slug} />);

    await screen.findByRole("heading", { name: soldProduct.title });
    expect(screen.getByRole("status").textContent).toContain("Sold");
    expect(screen.getByText("Listed price")).toBeTruthy();
    expect(screen.getByText("€125.00")).toBeTruthy();
    expect(screen.getByText(soldProduct.conditionDescription!)).toBeTruthy();
    for (const value of ["1930s", "Brass and glass", "France", "20 × 12 × 30 cm", "2.5 kg"]) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(screen.getByText(soldProduct.description!)).toBeTruthy();
    expect(screen.getByText(soldProduct.productStory!)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Explore the archive" }).getAttribute("href")).toBe("/archive");
    expect(screen.queryByRole("button", { name: "Add to Cart" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make an Offer" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wishlist/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "View Cart" })).toBeNull();
  });

  it("keeps canonical sold metadata and emits non-purchasable Product structured data", async () => {
    const metadata = await generateMetadata({ params: { slug: soldProduct.slug } });
    expect(metadata.alternates?.canonical).toBe(`http://localhost:3000/product/${soldProduct.slug}`);
    expect(metadata.robots).toBeUndefined();

    const page = await ProductPage({ params: { slug: soldProduct.slug } });
    render(page);
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script?.textContent).toContain('"@type":"Product"');
    expect(script?.textContent).not.toContain('"offers"');
  });

  it("keeps an archive-hidden sold product unavailable in server metadata and client recovery UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const metadata = await generateMetadata({ params: { slug: "private-sold-object" } });
    expect(metadata.title).toBe("Product Unavailable");
    expect(metadata.robots).toEqual({ index: false, follow: true });

    vi.mocked(api.get).mockRejectedValue(new ApiError("Product not found", 404));
    render(<ProductDetailClient slug="private-sold-object" />);

    await screen.findByRole("heading", { name: "This item may have been sold or is no longer available" });
    expect(screen.getByRole("link", { name: "Browse the Archive" }).getAttribute("href")).toBe("/archive");
    expect(screen.getByRole("link", { name: "Return to Shop" }).getAttribute("href")).toBe("/shop");
    expect(screen.queryByText("Preserved in the Noctella archive as a collectible reference.")).toBeNull();
    expect(screen.queryByText("Listed price")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to Cart" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make an Offer" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wishlist/ })).toBeNull();
  });

  it("renders archive cards at canonical PDP links with resolved imagery", async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [soldProduct], total: 1, page: 1, pageSize: 12 } as never);
    render(<ArchivePage />);

    const card = await screen.findByRole("link", { name: /Archival Brass Clock/ });
    expect(card.getAttribute("href")).toBe(`/product/${soldProduct.slug}`);
    expect(screen.getByRole("img", { name: "Brass clock" }).getAttribute("src")).toBe("http://localhost:4000/clock.webp");
    expect(screen.getByText("Sold")).toBeTruthy();
    expect(screen.getByText("Page 1 of 1 (1 items)")).toBeTruthy();
  });

  it("defines 4:5 archival imagery and narrow-screen responsive spacing", async () => {
    const css = await readFile(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".sf-archive { max-width: 1280px; margin: 0 auto; padding: 48px clamp(16px, 4vw, 40px);");
    expect(css).toContain(".sf-archive__image { position: relative; aspect-ratio: 4 / 5;");
    expect(css).toContain(".sf-archive__pagination { align-items: flex-start; flex-direction: column;");
  });
});
