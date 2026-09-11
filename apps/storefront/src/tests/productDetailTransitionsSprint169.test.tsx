// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductDetailClient } from "@/app/product/[slug]/ProductDetailClient";
import { ProductGallery } from "@/components/ProductGallery";
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

function product(id: string, overrides: Partial<PublicProductDetail> = {}): PublicProductDetail {
  return {
    id,
    slug: id,
    title: `Product ${id.toUpperCase()}`,
    type: "unique_item",
    priceEur: 100,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: true,
    allowCashOnDelivery: true,
    status: "published",
    images: [{ id: `${id}-image-1`, url: `/${id}-1.webp`, altText: `${id} first`, sortOrder: 0, isPrimary: true }],
    relatedProducts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Sprint 169 product detail route transitions", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  afterEach(cleanup);

  it("immediately replaces a resolved prior product with loading for the new slug", async () => {
    const next = deferred<PublicProductDetail>();
    vi.mocked(api.get).mockImplementation(async (path: string) => path.endsWith("/a") ? product("a") as never : next.promise as never);
    const view = render(<ProductDetailClient slug="a" />);
    expect(await screen.findByRole("heading", { name: "Product A" })).toBeTruthy();

    view.rerender(<ProductDetailClient slug="b" />);
    expect(screen.queryByRole("heading", { name: "Product A" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading...");

    next.resolve(product("b"));
    expect(await screen.findByRole("heading", { name: "Product B" })).toBeTruthy();
  });

  it("keeps the latest product when an older success resolves last", async () => {
    const older = deferred<PublicProductDetail>();
    const latest = deferred<PublicProductDetail>();
    vi.mocked(api.get).mockImplementation((path: string) => (path.endsWith("/a") ? older.promise : latest.promise) as never);
    const view = render(<ProductDetailClient slug="a" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    view.rerender(<ProductDetailClient slug="b" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    latest.resolve(product("b"));
    expect(await screen.findByRole("heading", { name: "Product B" })).toBeTruthy();
    older.resolve(product("a"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Product A" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Product B" })).toBeTruthy();
  });

  it.each([
    ["404", new ApiError("not found", 404)],
    ["general error", new Error("network")],
  ])("ignores an obsolete %s after the latest product succeeds", async (_label, obsoleteError) => {
    const older = deferred<PublicProductDetail>();
    const latest = deferred<PublicProductDetail>();
    vi.mocked(api.get).mockImplementation((path: string) => (path.endsWith("/a") ? older.promise : latest.promise) as never);
    const view = render(<ProductDetailClient slug="a" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    view.rerender(<ProductDetailClient slug="b" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    latest.resolve(product("b"));
    expect(await screen.findByRole("heading", { name: "Product B" })).toBeTruthy();

    older.reject(obsoleteError);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText(/may have been sold/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Product B" })).toBeTruthy();
  });

  it.each([
    ["404", new ApiError("not found", 404), "This item may have been sold or is no longer available"],
    ["general error", new Error("network"), "Something went wrong loading this product. Please try again."],
  ])("renders a current %s outcome", async (_label, currentError, expected) => {
    vi.mocked(api.get).mockRejectedValue(currentError);
    render(<ProductDetailClient slug="a" />);
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it.each([
    ["404", new ApiError("not found", 404)],
    ["general error", new Error("network")],
  ])("recovers from a current %s when navigation reaches a valid slug", async (_label, firstError) => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.endsWith("/a")) throw firstError;
      return product("b") as never;
    });
    const view = render(<ProductDetailClient slug="a" />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    view.rerender(<ProductDetailClient slug="b" />);
    expect(await screen.findByRole("heading", { name: "Product B" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/may have been sold/i)).toBeNull();
  });

  it("resets offer and cart feedback and derives wishlist/cart state from the latest product", async () => {
    localStorage.setItem("noctella_wishlist", JSON.stringify(["b"]));
    localStorage.setItem("noctella_cart", JSON.stringify([{
      productId: "b", slug: "b", title: "Product B", eurPrice: 100, quantity: 1,
      productType: "unique_item", allowCashOnDelivery: true,
    }]));
    vi.mocked(api.get).mockImplementation(async (path: string) => path.endsWith("/a") ? product("a") as never : product("b") as never);
    const view = render(<ProductDetailClient slug="a" />);
    await screen.findByRole("heading", { name: "Product A" });
    fireEvent.click(screen.getByRole("button", { name: "Make an Offer" }));
    expect(screen.getByRole("heading", { name: "Make an Offer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to Cart" }));
    expect(screen.getByRole("button", { name: "Added to Cart" })).toBeTruthy();

    view.rerender(<ProductDetailClient slug="b" />);
    expect(await screen.findByRole("heading", { name: "Product B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Make an Offer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Added to Cart" })).toBeNull();
    expect(screen.getByRole("button", { name: "Already in Cart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from Wishlist" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("resets a later active image when transitioning to a one-image gallery", () => {
    const imagesA = [
      product("a").images[0],
      { id: "a-image-2", url: "/a-2.webp", altText: "a second", sortOrder: 1, isPrimary: false },
    ];
    const imagesB = product("b").images;
    const view = render(<ProductGallery images={imagesA} title="Product A" />);
    fireEvent.click(screen.getByRole("button", { name: "View image 2 of 2" }));
    expect(screen.getByRole("button", { name: "View image 2 of 2" }).getAttribute("aria-current")).toBe("true");

    expect(() => view.rerender(<ProductGallery images={imagesB} title="Product B" />)).not.toThrow();
    expect(screen.getByRole("button", { name: "Zoom image: b first" })).toBeTruthy();
  });

  it("closes zoom when the gallery identity changes but preserves normal same-product selection", async () => {
    const imagesA = [
      product("a").images[0],
      { id: "a-image-2", url: "/a-2.webp", altText: "a second", sortOrder: 1, isPrimary: false },
    ];
    const view = render(<ProductGallery images={imagesA} title="Product A" />);
    fireEvent.click(screen.getByRole("button", { name: "View image 2 of 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: a second" }));
    expect(screen.getByRole("dialog", { name: "Product A enlarged image" })).toBeTruthy();

    view.rerender(<ProductGallery images={product("b").images} title="Product B" />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Zoom image: b first" })).toBeTruthy();
  });
});
