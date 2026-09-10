// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShopPage from "@/app/shop/page";
import { api } from "@/lib/api";

const navigation = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.params,
}));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { get: vi.fn() } }));

describe("Sprint 167 marketplace shop", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.params = new URLSearchParams("search=clock&category=timepieces&collection=icons&sort=price_desc&page=3");
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (String(path).includes("/products?")) return { items: [], total: 0, page: 3, pageSize: 12 } as never;
      if (String(path).includes("categories")) return { items: [{ id: "cat", name: "Timepieces", slug: "timepieces" }] } as never;
      return { items: [{ id: "col", name: "Icons", slug: "icons" }] } as never;
    });
  });
  afterEach(cleanup);

  it("restores committed URL controls and maps them to existing API parameters", async () => {
    render(<ShopPage />);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("clock");
    await waitFor(() => expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("timepieces"));
    expect((screen.getByLabelText("Collection") as HTMLSelectElement).value).toBe("icons");
    expect((screen.getByLabelText("Sort by") as HTMLSelectElement).value).toBe("price_desc");
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([path]) => String(path).includes("page=3&pageSize=12&sort=price_desc&search=clock&categorySlug=timepieces&collectionSlug=icons"))).toBe(true));
  });

  it("does not request while typing and commits a trimmed search on submit with page reset", async () => {
    render(<ShopPage />);
    await screen.findByText("No products match your search.");
    const requestsBeforeTyping = vi.mocked(api.get).mock.calls.filter(([path]) => String(path).includes("/products?")).length;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  brass & clock  " } });
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => String(path).includes("/products?")).length).toBe(requestsBeforeTyping);
    fireEvent.submit(screen.getByRole("search"));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=brass+%26+clock&category=timepieces&collection=icons&sort=price_desc");
  });

  it("clears a blank search, resets filters, and preserves committed state during pagination", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => String(path).includes("/products?")
      ? { items: [{ id: "p", slug: "p", title: "Clock", type: "unique_item", priceEur: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, status: "published", images: [], createdAt: "", updatedAt: "" }], total: 48, page: 3, pageSize: 12 } as never
      : { items: [] } as never);
    render(<ShopPage />);
    await screen.findByText("Clock");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "   " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(navigation.push).toHaveBeenCalledWith("/shop?category=timepieces&collection=icons&sort=price_desc");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=clock&category=timepieces&collection=icons&sort=price_desc&page=4");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop");
  });
});
