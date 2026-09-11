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

const product = {
  id: "p",
  slug: "clock",
  title: "Clock",
  type: "unique_item",
  priceEur: 1,
  customsWarning: false,
  isFeatured: false,
  allowMakeOffer: false,
  allowCashOnDelivery: true,
  status: "published",
  images: [],
  createdAt: "",
  updatedAt: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Sprint 168 marketplace browse refinement", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.params = new URLSearchParams("search=clock&category=timepieces&collection=icons&sort=price_desc&page=3");
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (String(path).includes("/products?")) return { items: [product], total: 48, page: 3, pageSize: 12 } as never;
      if (String(path).includes("categories")) return { items: [{ id: "cat", name: "Timepieces", slug: "timepieces" }] } as never;
      return { items: [{ id: "col", name: "Icons", slug: "icons" }] } as never;
    });
  });

  afterEach(cleanup);

  it("renders active browse filters with metadata labels, but not sort, and reports the API total", async () => {
    render(<ShopPage />);

    expect(await screen.findByText("48 results")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Search filter: clock" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Remove Category filter: Timepieces" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Remove Collection filter: Icons" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove Sort/i })).toBeNull();
  });

  it("removes individual filters while preserving the remaining URL state and resetting page", async () => {
    render(<ShopPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Search filter: clock" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop?category=timepieces&collection=icons&sort=price_desc");

    fireEvent.click(await screen.findByRole("button", { name: "Remove Category filter: Timepieces" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=clock&collection=icons&sort=price_desc");
  });

  it("clears all filters while preserving non-default sort", async () => {
    render(<ShopPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear all filters" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop?sort=price_desc");
  });

  it("uses singular result wording for the actual API total", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => String(path).includes("/products?")
      ? { items: [product], total: 1, page: 1, pageSize: 12 } as never
      : { items: [] } as never);
    render(<ShopPage />);
    expect(await screen.findByText("1 result")).toBeTruthy();
  });

  it("provides a Shop-specific empty state with filter-preserving recovery behavior", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => String(path).includes("/products?")
      ? { items: [], total: 0, page: 3, pageSize: 12 } as never
      : { items: [] } as never);
    render(<ShopPage />);

    expect(await screen.findByRole("heading", { name: "No matching products found" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters and browse all" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop?sort=price_desc");
  });

  it("preserves committed browse state during pagination", async () => {
    render(<ShopPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=clock&category=timepieces&collection=icons&sort=price_desc&page=4");
  });

  it("does not request while typing and commits trimmed search only on submit", async () => {
    render(<ShopPage />);
    await screen.findByText("Clock");
    const requestsBeforeTyping = vi.mocked(api.get).mock.calls.filter(([path]) => String(path).includes("/products?")).length;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  brass & clock  " } });
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.filter(([path]) => String(path).includes("/products?"))).toHaveLength(requestsBeforeTyping));
    fireEvent.submit(screen.getByRole("search"));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=brass+%26+clock&category=timepieces&collection=icons&sort=price_desc");
  });

  it("suppresses resolved content while the newly committed browse request is pending", async () => {
    const nextRequest = deferred<{ items: typeof product[]; total: number; page: number; pageSize: number }>();
    let productRequest = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (!String(path).includes("/products?")) return { items: [] } as never;
      productRequest += 1;
      if (productRequest === 1) return { items: [product], total: 48, page: 3, pageSize: 12 } as never;
      return nextRequest.promise as never;
    });
    const view = render(<ShopPage />);
    expect(await screen.findByText("48 results")).toBeTruthy();
    expect(screen.getByText("Clock")).toBeTruthy();

    navigation.params = new URLSearchParams("search=lamp&sort=price_desc");
    view.rerender(<ShopPage />);

    expect(screen.queryByText("48 results")).toBeNull();
    expect(screen.queryByText("Clock")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading...");

    nextRequest.resolve({ items: [{ ...product, id: "lamp", slug: "lamp", title: "Lamp" }], total: 1, page: 1, pageSize: 12 });
    expect(await screen.findByText("1 result")).toBeTruthy();
    expect(screen.getByText("Lamp")).toBeTruthy();
  });

  it("ignores an older response that resolves after the latest browse request", async () => {
    const olderRequest = deferred<{ items: typeof product[]; total: number; page: number; pageSize: number }>();
    const latestRequest = deferred<{ items: typeof product[]; total: number; page: number; pageSize: number }>();
    const productRequests = [olderRequest, latestRequest];
    let productRequest = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (!String(path).includes("/products?")) return { items: [] } as never;
      return productRequests[productRequest++].promise as never;
    });
    const view = render(<ShopPage />);
    await waitFor(() => expect(productRequest).toBe(1));

    navigation.params = new URLSearchParams("search=lamp&sort=price_desc");
    view.rerender(<ShopPage />);
    await waitFor(() => expect(productRequest).toBe(2));
    latestRequest.resolve({ items: [{ ...product, id: "lamp", slug: "lamp", title: "Lamp" }], total: 1, page: 1, pageSize: 12 });
    expect(await screen.findByText("Lamp")).toBeTruthy();

    olderRequest.resolve({ items: [product], total: 48, page: 3, pageSize: 12 });
    await waitFor(() => {
      expect(screen.getByText("1 result")).toBeTruthy();
      expect(screen.queryByText("Clock")).toBeNull();
    });
  });

  it("ignores an obsolete error after the latest browse request succeeds", async () => {
    const olderRequest = deferred<{ items: typeof product[]; total: number; page: number; pageSize: number }>();
    const latestRequest = deferred<{ items: typeof product[]; total: number; page: number; pageSize: number }>();
    const productRequests = [olderRequest, latestRequest];
    let productRequest = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (!String(path).includes("/products?")) return { items: [] } as never;
      return productRequests[productRequest++].promise as never;
    });
    const view = render(<ShopPage />);
    await waitFor(() => expect(productRequest).toBe(1));
    navigation.params = new URLSearchParams("search=lamp");
    view.rerender(<ShopPage />);
    await waitFor(() => expect(productRequest).toBe(2));

    latestRequest.resolve({ items: [{ ...product, id: "lamp", slug: "lamp", title: "Lamp" }], total: 1, page: 1, pageSize: 12 });
    expect(await screen.findByText("Lamp")).toBeTruthy();
    olderRequest.reject(new Error("obsolete"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("1 result")).toBeTruthy();
  });

  it("falls back to taxonomy slugs and removes a fallback chip safely", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => String(path).includes("/products?")
      ? { items: [product], total: 1, page: 3, pageSize: 12 } as never
      : { items: [] } as never);
    render(<ShopPage />);

    const categoryChip = await screen.findByRole("button", { name: "Remove Category filter: timepieces" });
    expect(screen.getByRole("button", { name: "Remove Collection filter: icons" })).toBeTruthy();
    fireEvent.click(categoryChip);
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=clock&collection=icons&sort=price_desc");
  });

  it("does not show clear all for default or sort-only browse state", async () => {
    navigation.params = new URLSearchParams("sort=price_asc");
    vi.mocked(api.get).mockImplementation(async (path: string) => String(path).includes("/products?")
      ? { items: [product], total: 1, page: 1, pageSize: 12 } as never
      : { items: [] } as never);
    const view = render(<ShopPage />);
    await screen.findByText("1 result");
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();

    navigation.params = new URLSearchParams();
    view.rerender(<ShopPage />);
    await screen.findByText("1 result");
    expect(screen.queryByRole("button", { name: "Clear all filters" })).toBeNull();
  });
});
