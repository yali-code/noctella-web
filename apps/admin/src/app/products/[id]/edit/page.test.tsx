// @vitest-environment jsdom
// Sprint 88 (ADR-017): proves EditProductPage owns the version token separately from
// ProductFormValues - initialized from GET's Product.updatedAt, forwarded as expectedUpdatedAt on
// PUT, replaced with the successful response's updatedAt (enabling a second save with the fresh
// token), left unchanged on a version conflict (no router.push in that case), and that the
// explicit reload action performs only the approved reload.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import * as apiLib from "@/lib/api";
import EditProductPage from "./page";

afterEach(() => {
  vi.restoreAllMocks();
  // push is a plain vi.fn() referenced by the module-level next/navigation mock, not a spy on an
  // existing object - restoreAllMocks() does not clear its call history between tests.
  push.mockClear();
});

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

/**
 * ProductForm also fetches /api/categories and /api/collections on mount - a blanket
 * mockResolvedValue on api.get would resolve those with the Product object too, and
 * `res.items` being undefined then crashes the categories.map() render. Route by path instead.
 */
function mockGetForProduct(product: any) {
  return vi.spyOn(apiLib.api, "get").mockImplementation(async (path: string) => {
    if (path === `/api/products/${product.id}`) return product;
    return { items: [] };
  });
}

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    sku: "SKU-1",
    title: "Original Title",
    slug: "original-title",
    type: "unique",
    status: "draft",
    categoryId: "cat-1",
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    priceEur: 100,
    images: [],
    photos: [],
    marketplaceReadiness: { ebay: { ready: false, missingFields: [] }, etsy: { ready: false, missingFields: [] }, woocommerce: { ready: false, missingFields: [] } },
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as any;
}

describe("EditProductPage — Sprint 88 version-token ownership", () => {
  it("initializes the token from GET, forwards it on PUT, replaces it on success, and a second save uses the new token", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    const getSpy = mockGetForProduct(product);
    const putSpy = vi
      .spyOn(apiLib.api, "put")
      .mockResolvedValueOnce(baseProduct({ title: "Saved Once", updatedAt: "2026-01-02T00:00:00.000Z" }))
      .mockResolvedValueOnce(baseProduct({ title: "Saved Twice", updatedAt: "2026-01-03T00:00:00.000Z" }));

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");
    expect(getSpy).toHaveBeenCalledWith("/api/products/p1");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy).toHaveBeenNthCalledWith(1, "/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/products/p1"));

    // Second save (component stays mounted) must use the token from the first successful response.
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    expect(putSpy).toHaveBeenNthCalledWith(2, "/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-02T00:00:00.000Z" }));
  });

  it("leaves the token unchanged and does not navigate on a version conflict", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    const putSpy = vi.spyOn(apiLib.api, "put").mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT", {
        productId: "p1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        currentUpdatedAt: "2026-01-05T00:00:00.000Z",
      }),
    );

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Reload Latest Product" });
    expect(push).not.toHaveBeenCalled();

    // A retried save must still use the original (unchanged) token, not something derived from the conflict.
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    expect(putSpy).toHaveBeenNthCalledWith(2, "/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }));
  });

  it("clicking the explicit reload action performs only the approved reload, not an automatic one", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    vi.spyOn(apiLib.api, "put").mockRejectedValue(
      new ApiError("Reload required", 409, undefined, "PRODUCT_VERSION_CONFLICT", { productId: "p1", expectedUpdatedAt: "old", currentUpdatedAt: "new" }),
    );
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    const reloadButton = await screen.findByRole("button", { name: "Reload Latest Product" });
    expect(reload).not.toHaveBeenCalled();

    await user.click(reloadButton);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
