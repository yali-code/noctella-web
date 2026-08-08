// @vitest-environment jsdom
// Sprint 109: Product Detail must expose a discoverable navigation path to the existing Product
// Edit page (/products/[id]/edit) - the manual channel fields (eBay category, eBay/Etsy/Noctella
// Web listing price) required to complete Publish Readiness are only editable there.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as apiLib from "@/lib/api";
import ProductViewPage from "./page";

afterEach(() => vi.restoreAllMocks());

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    sku: "SKU-1",
    title: "Original Title",
    slug: "original-title",
    type: "unique",
    status: "draft",
    priceEur: 100,
    stockQuantity: 1,
    images: [],
    photos: [],
    marketplaceReadiness: {
      ebay: { ready: false, missingFields: [] },
      etsy: { ready: false, missingFields: [] },
      woocommerce: { ready: false, missingFields: [] },
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as any;
}

describe("ProductViewPage — Sprint 109 Edit Product navigation", () => {
  it("renders an Edit Product link pointing to /products/<id>/edit", async () => {
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct());
    render(<ProductViewPage params={{ id: "p1" }} />);

    const link = await screen.findByRole("link", { name: "Edit Product" });
    expect(link).toHaveAttribute("href", "/products/p1/edit");
  });
});
