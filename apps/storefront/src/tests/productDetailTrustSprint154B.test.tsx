// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductDetailClient } from "@/app/product/[slug]/ProductDetailClient";
import { ProductGallery } from "@/components/ProductGallery";
import { api } from "@/lib/api";
import type { PublicProductDetail } from "@/lib/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { get: vi.fn(), post: vi.fn() } }));

const completeProduct: PublicProductDetail = {
  id: "product-154b", slug: "brass-clock", title: "A Long-Titled Antique Brass Clock", type: "unique_item",
  shortDescription: "An object with a documented surface condition.", description: "Original leather case included.",
  productStory: "A concise history.", condition: "Very good", conditionDescription: "Light surface wear consistent with age.",
  period: "1930s", materials: "Brass and glass", countryOfOrigin: "France",
  lengthValue: 20, widthValue: 12, heightValue: 30, dimensionUnit: "cm", weightValue: 2.5, weightUnit: "kg",
  priceEur: 125, shippingNote: "Ships in protective packaging.", customsWarning: true, isFeatured: false,
  allowMakeOffer: true, allowCashOnDelivery: false, status: "published",
  images: [{ id: "image-1", url: "/clock.webp", altText: "Brass clock", sortOrder: 0, isPrimary: true }],
  relatedProducts: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Sprint 154B PDP trust foundation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.get).mockReset().mockResolvedValue(completeProduct as never);
  });
  afterEach(cleanup);

  it("labels cosmetic condition explicitly and renders only authoritative populated facts", async () => {
    render(<ProductDetailClient slug={completeProduct.slug} />);
    await screen.findByRole("heading", { name: completeProduct.title });
    expect(screen.getByText("Cosmetic condition")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Condition details" })).toBeTruthy();
    expect(screen.getByText(completeProduct.conditionDescription!)).toBeTruthy();
    for (const value of ["1930s", "Brass and glass", "France", "20 × 12 × 30 cm", "2.5 kg"]) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(screen.getByText("Original leather case included.")).toBeTruthy();
    const generatedTrustLabels = Array.from(document.querySelectorAll(".sf-pdp__facts dt, .sf-pdp__section h2"), (element) => element.textContent);
    for (const label of ["Functional status", "Working", "Tested", "Untested", "Restoration status", "Preserved", "Completeness", "Included items", "Authentication status", "In stock", "Ships from Bulgaria"]) {
      expect(generatedTrustLabels).not.toContain(label);
    }
  });

  it("omits absent condition details and optional facts without inventing fallbacks", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...completeProduct, condition: undefined, conditionDescription: undefined, period: undefined,
      materials: undefined, countryOfOrigin: undefined, lengthValue: undefined, widthValue: undefined,
      heightValue: undefined, dimensionUnit: undefined, weightValue: undefined, weightUnit: undefined,
    } as never);
    render(<ProductDetailClient slug={completeProduct.slug} />);
    await screen.findByRole("heading", { name: completeProduct.title });
    expect(screen.queryByText("Cosmetic condition")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Condition details" })).toBeNull();
    expect(screen.queryByText("Period")).toBeNull();
    expect(screen.queryByText("Materials")).toBeNull();
    expect(screen.queryByText("Country of origin")).toBeNull();
    expect(screen.queryByText("Dimensions")).toBeNull();
    expect(screen.queryByText("Weight")).toBeNull();
  });

  it("preserves wishlist, Add to Cart, and allowMakeOffer behavior", async () => {
    render(<ProductDetailClient slug={completeProduct.slug} />);
    const wishlist = await screen.findByRole("button", { name: "Add to Wishlist" });
    expect(screen.getByRole("button", { name: "Make an Offer" })).toBeTruthy();
    fireEvent.click(wishlist);
    expect(wishlist.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    expect(JSON.parse(localStorage.getItem("noctella_cart") ?? "[]")[0]).toMatchObject({ productId: completeProduct.id, quantity: 1 });
  });

  it("links category and collection, reports availability, and removes the disabled AI action", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...completeProduct,
      categoryName: "Timepieces",
      categorySlug: "timepieces",
      collectionName: "Curator's Pick",
      collectionSlug: "curators-pick",
      allowCashOnDelivery: true,
    } as never);
    render(<ProductDetailClient slug={completeProduct.slug} />);
    expect((await screen.findByRole("link", { name: "Timepieces" })).getAttribute("href")).toBe("/category/timepieces");
    expect(screen.getByRole("link", { name: "Curator's Pick" }).getAttribute("href")).toBe("/collection/curators-pick");
    expect(screen.getByText("Available · Cash on Delivery available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask AI" })).toBeNull();
  });

  it("omits Make Offer when allowMakeOffer is false", async () => {
    vi.mocked(api.get).mockResolvedValue({ ...completeProduct, allowMakeOffer: false } as never);
    render(<ProductDetailClient slug={completeProduct.slug} />);
    await screen.findByRole("heading", { name: completeProduct.title });
    expect(screen.queryByRole("button", { name: "Make an Offer" })).toBeNull();
  });

  it("retains accessible thumbnail selection and zoom while using non-destructive presentation", async () => {
    const images = [
      completeProduct.images[0],
      { id: "image-2", url: "/clock-side.webp", altText: "Clock side", sortOrder: 1, isPrimary: false },
    ];
    render(<ProductGallery images={images} title={completeProduct.title} />);
    expect(screen.getByRole("button", { name: "View image 1 of 2" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "View image 2 of 2" }));
    expect(screen.getByRole("button", { name: "View image 2 of 2" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Zoom image: Clock side/ }));
    expect(screen.getByRole("dialog", { name: `${completeProduct.title} enlarged image` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close enlarged image" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close enlarged image" })));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close enlarged image" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Zoom image: Clock side/ })));

    const css = await readFile(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain(".sf-pdp-gallery__main img");
    expect(css).toContain("object-fit: contain");
    expect(css).toContain("aspect-ratio: 4 / 5");
  });
});
