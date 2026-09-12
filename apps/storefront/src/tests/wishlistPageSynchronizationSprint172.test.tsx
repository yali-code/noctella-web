// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WishlistPage from "../app/wishlist/page";
import { api } from "../lib/api";
import type { PaginatedResult, PublicProduct } from "../lib/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  api: { get: vi.fn(), post: vi.fn() },
}));

const product = (id: string): PublicProduct => ({
  id,
  slug: id,
  title: `Item ${id.toUpperCase()}`,
  type: "unique_item",
  priceEur: 10,
  customsWarning: false,
  isFeatured: false,
  allowMakeOffer: false,
  allowCashOnDelivery: true,
  status: "published",
  images: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const itemA = product("a");
const itemB = product("b");

function catalog(items: PublicProduct[]): PaginatedResult<PublicProduct> {
  return { items, total: items.length, page: 1, pageSize: 100 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setIds(ids: string[]) {
  localStorage.setItem("noctella_wishlist", JSON.stringify(ids));
}

function wishlistUpdated() {
  window.dispatchEvent(new Event("noctella:wishlist-updated"));
}

function storageChanged(key: string | null = "noctella_wishlist") {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

describe("Sprint 172 Wishlist page source-of-truth synchronization", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  afterEach(cleanup);

  it("resolves and renders multiple initial wishlist IDs", async () => {
    setIds(["a", "b"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    expect(await screen.findByText("Item A")).toBeTruthy();
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/public/products/resolve", { ids: ["a", "b"] });
  });

  it("removes one card immediately after its same-tab ProductCard toggle", async () => {
    setIds(["a", "b"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    fireEvent.click(screen.getByRole("button", { name: "Remove Item A from wishlist" }));
    expect(screen.queryByText("Item A")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("shows the empty state immediately after removing the last card", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    fireEvent.click(screen.getByRole("button", { name: "Remove Item A from wishlist" }));
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
  });

  it("renders a same-tab addition from resolved cache without refetching", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["a", "b"]);
    act(wishlistUpdated);
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("reloads the bounded resolver for an unresolved same-tab addition", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValueOnce(catalog([itemA])).mockResolvedValueOnce(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["a", "b"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item B")).toBeTruthy();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("resolves empty-to-non-empty membership without remounting", async () => {
    vi.mocked(api.post).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    expect(await screen.findByText(/Your wishlist is empty/)).toBeTruthy();
    setIds(["a"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item A")).toBeTruthy();
    expect(api.post).toHaveBeenCalledOnce();
  });

  it("renders eligible results while leaving unavailable membership unresolved", async () => {
    setIds(["a", "missing"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    expect(await screen.findByText("Item A")).toBeTruthy();
    expect(screen.queryByText(/Your wishlist is empty/)).toBeNull();
    expect(api.post).toHaveBeenCalledWith("/api/public/products/resolve", { ids: ["a", "missing"] });
  });

  it("batches more than 100 unique membership IDs without truncation", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `product-${index}`);
    vi.mocked(api.post)
      .mockResolvedValueOnce(catalog(ids.slice(0, 100).map(product)))
      .mockResolvedValueOnce(catalog([product(ids[100])]));
    setIds(ids);
    render(<WishlistPage />);
    expect(await screen.findByText("Item PRODUCT-100")).toBeTruthy();
    expect(api.post).toHaveBeenNthCalledWith(1, "/api/public/products/resolve", { ids: ids.slice(0, 100) });
    expect(api.post).toHaveBeenNthCalledWith(2, "/api/public/products/resolve", { ids: [ids[100]] });
  });

  it("reconciles a relevant cross-tab storage event", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["b"]);
    act(storageChanged);
    expect(screen.queryByText("Item A")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("reconciles a storage-clear event whose key is null", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    localStorage.clear();
    act(() => storageChanged(null));
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
  });

  it("ignores irrelevant storage events", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["b"]);
    act(() => storageChanged("noctella_cart"));
    expect(screen.getByText("Item A")).toBeTruthy();
    expect(screen.queryByText("Item B")).toBeNull();
    expect(api.post).toHaveBeenCalledOnce();
  });

  it("does not refetch or show loading when removing from resolved products", async () => {
    setIds(["a", "b"]);
    vi.mocked(api.post).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    fireEvent.click(screen.getByRole("button", { name: "Remove Item A from wishlist" }));
    expect(api.post).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("preserves the existing blocking initial-load error", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockRejectedValue(new Error("network"));
    render(<WishlistPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong loading your wishlist");
  });

  it("preserves valid products when a background addition reload fails", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockResolvedValueOnce(catalog([itemA])).mockRejectedValueOnce(new Error("network"));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["a", "b"]);
    act(wishlistUpdated);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Item A")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers from a current failure on a later relevant event", async () => {
    setIds(["a"]);
    vi.mocked(api.post).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByRole("alert");
    act(wishlistUpdated);
    expect(await screen.findByText("Item A")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps newer membership when request successes resolve in reverse order", async () => {
    const older = deferred<PaginatedResult<PublicProduct>>();
    const newer = deferred<PaginatedResult<PublicProduct>>();
    setIds(["a"]);
    vi.mocked(api.post).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    setIds(["b"]);
    act(wishlistUpdated);
    await act(async () => { newer.resolve(catalog([itemB])); await newer.promise; });
    expect(screen.getByText("Item B")).toBeTruthy();
    await act(async () => { older.resolve(catalog([itemA])); await older.promise; });
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(screen.queryByText("Item A")).toBeNull();
  });

  it("suppresses a stale failure after a newer success", async () => {
    const older = deferred<PaginatedResult<PublicProduct>>();
    setIds(["a"]);
    vi.mocked(api.post).mockReturnValueOnce(older.promise).mockResolvedValueOnce(catalog([itemB]));
    render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    setIds(["b"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item B")).toBeTruthy();
    await act(async () => { older.reject(new Error("obsolete")); try { await older.promise; } catch {} });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("suppresses stale later-batch failure and finalization after membership changes", async () => {
    const staleSecondBatch = deferred<PaginatedResult<PublicProduct>>();
    const ids = Array.from({ length: 101 }, (_, index) => `old-${index}`);
    vi.mocked(api.post)
      .mockResolvedValueOnce(catalog(ids.slice(0, 100).map(product)))
      .mockReturnValueOnce(staleSecondBatch.promise)
      .mockResolvedValueOnce(catalog([itemB]));
    setIds(ids);
    render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    setIds(["b"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item B")).toBeTruthy();
    await act(async () => { staleSecondBatch.reject(new Error("obsolete")); try { await staleSecondBatch.promise; } catch {} });
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("suppresses stale later-batch success after membership changes", async () => {
    const staleSecondBatch = deferred<PaginatedResult<PublicProduct>>();
    const ids = Array.from({ length: 101 }, (_, index) => `old-success-${index}`);
    vi.mocked(api.post)
      .mockResolvedValueOnce(catalog(ids.slice(0, 100).map(product)))
      .mockReturnValueOnce(staleSecondBatch.promise)
      .mockResolvedValueOnce(catalog([itemB]));
    setIds(ids);
    render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    setIds(["b"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item B")).toBeTruthy();
    await act(async () => { staleSecondBatch.resolve(catalog([product(ids[100])])); await staleSecondBatch.promise; });
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(screen.queryByText("Item OLD-SUCCESS-100")).toBeNull();
  });

  it("does not let stale finalization end a newer pending load", async () => {
    const older = deferred<PaginatedResult<PublicProduct>>();
    const newer = deferred<PaginatedResult<PublicProduct>>();
    setIds(["a"]);
    vi.mocked(api.post).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    setIds(["b"]);
    act(wishlistUpdated);
    await act(async () => { older.resolve(catalog([itemA])); await older.promise; });
    expect(screen.getByRole("status").textContent).toBe("Loading...");
    await act(async () => { newer.resolve(catalog([itemB])); await newer.promise; });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("invalidates pending catalog work when membership becomes empty", async () => {
    const pending = deferred<PaginatedResult<PublicProduct>>();
    setIds(["a"]);
    vi.mocked(api.post).mockReturnValue(pending.promise);
    render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    setIds([]);
    act(wishlistUpdated);
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
    await act(async () => { pending.resolve(catalog([itemA])); await pending.promise; });
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
    expect(screen.queryByText("Item A")).toBeNull();
  });

  it("removes listeners on unmount", async () => {
    vi.mocked(api.post).mockResolvedValue(catalog([itemA]));
    const view = render(<WishlistPage />);
    expect(await screen.findByText(/Your wishlist is empty/)).toBeTruthy();
    view.unmount();
    setIds(["a"]);
    act(wishlistUpdated);
    storageChanged();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("prevents a pending completion from reading response data after unmount", async () => {
    const pending = deferred<PaginatedResult<PublicProduct>>();
    const itemsRead = vi.fn(() => [itemA]);
    setIds(["a"]);
    vi.mocked(api.post).mockReturnValue(pending.promise);
    const view = render(<WishlistPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    view.unmount();
    const response = { total: 1, page: 1, pageSize: 100 } as PaginatedResult<PublicProduct>;
    Object.defineProperty(response, "items", { get: itemsRead });
    await act(async () => { pending.resolve(response); await pending.promise; });
    expect(itemsRead).not.toHaveBeenCalled();
  });

  it("prevents an invalidated Strict Mode request from committing", async () => {
    const invalidated = deferred<PaginatedResult<PublicProduct>>();
    const current = deferred<PaginatedResult<PublicProduct>>();
    setIds(["a"]);
    vi.mocked(api.post).mockReturnValueOnce(invalidated.promise).mockReturnValueOnce(current.promise);
    render(<StrictMode><WishlistPage /></StrictMode>);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await act(async () => { current.resolve(catalog([itemA])); await current.promise; });
    expect(screen.getByText("Item A")).toBeTruthy();
    await act(async () => { invalidated.resolve(catalog([itemB])); await invalidated.promise; });
    expect(screen.getByText("Item A")).toBeTruthy();
    expect(screen.queryByText("Item B")).toBeNull();
  });
});
