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
    vi.mocked(api.get).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    expect(await screen.findByText("Item A")).toBeTruthy();
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/public/products?pageSize=100");
  });

  it("removes one card immediately after its same-tab ProductCard toggle", async () => {
    setIds(["a", "b"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    fireEvent.click(screen.getByRole("button", { name: "Remove Item A from wishlist" }));
    expect(screen.queryByText("Item A")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("shows the empty state immediately after removing the last card", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    fireEvent.click(screen.getByRole("button", { name: "Remove Item A from wishlist" }));
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
  });

  it("renders a same-tab addition from resolved cache without refetching", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["a", "b"]);
    act(wishlistUpdated);
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("reloads the bounded catalog for an unresolved same-tab addition", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValueOnce(catalog([itemA])).mockResolvedValueOnce(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["a", "b"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item B")).toBeTruthy();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("resolves empty-to-non-empty membership without remounting", async () => {
    vi.mocked(api.get).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    expect(await screen.findByText(/Your wishlist is empty/)).toBeTruthy();
    setIds(["a"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item A")).toBeTruthy();
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("reconciles a relevant cross-tab storage event", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["b"]);
    act(storageChanged);
    expect(screen.queryByText("Item A")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("reconciles a storage-clear event whose key is null", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    localStorage.clear();
    act(() => storageChanged(null));
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
  });

  it("ignores irrelevant storage events", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["b"]);
    act(() => storageChanged("noctella_cart"));
    expect(screen.getByText("Item A")).toBeTruthy();
    expect(screen.queryByText("Item B")).toBeNull();
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("does not refetch or show loading when removing from resolved products", async () => {
    setIds(["a", "b"]);
    vi.mocked(api.get).mockResolvedValue(catalog([itemA, itemB]));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    fireEvent.click(screen.getByRole("button", { name: "Remove Item A from wishlist" }));
    expect(api.get).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("preserves the existing blocking initial-load error", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockRejectedValue(new Error("network"));
    render(<WishlistPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong loading your wishlist");
  });

  it("preserves valid products when a background addition reload fails", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockResolvedValueOnce(catalog([itemA])).mockRejectedValueOnce(new Error("network"));
    render(<WishlistPage />);
    await screen.findByText("Item A");
    setIds(["a", "b"]);
    act(wishlistUpdated);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Item A")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers from a current failure on a later relevant event", async () => {
    setIds(["a"]);
    vi.mocked(api.get).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(catalog([itemA]));
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
    vi.mocked(api.get).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<WishlistPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
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
    vi.mocked(api.get).mockReturnValueOnce(older.promise).mockResolvedValueOnce(catalog([itemB]));
    render(<WishlistPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    setIds(["b"]);
    act(wishlistUpdated);
    expect(await screen.findByText("Item B")).toBeTruthy();
    await act(async () => { older.reject(new Error("obsolete")); try { await older.promise; } catch {} });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Item B")).toBeTruthy();
  });

  it("does not let stale finalization end a newer pending load", async () => {
    const older = deferred<PaginatedResult<PublicProduct>>();
    const newer = deferred<PaginatedResult<PublicProduct>>();
    setIds(["a"]);
    vi.mocked(api.get).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<WishlistPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
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
    vi.mocked(api.get).mockReturnValue(pending.promise);
    render(<WishlistPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    setIds([]);
    act(wishlistUpdated);
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
    await act(async () => { pending.resolve(catalog([itemA])); await pending.promise; });
    expect(screen.getByText(/Your wishlist is empty/)).toBeTruthy();
    expect(screen.queryByText("Item A")).toBeNull();
  });

  it("removes listeners on unmount", async () => {
    vi.mocked(api.get).mockResolvedValue(catalog([itemA]));
    const view = render(<WishlistPage />);
    expect(await screen.findByText(/Your wishlist is empty/)).toBeTruthy();
    view.unmount();
    setIds(["a"]);
    act(wishlistUpdated);
    storageChanged();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("prevents a pending completion from reading response data after unmount", async () => {
    const pending = deferred<PaginatedResult<PublicProduct>>();
    const itemsRead = vi.fn(() => [itemA]);
    setIds(["a"]);
    vi.mocked(api.get).mockReturnValue(pending.promise);
    const view = render(<WishlistPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
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
    vi.mocked(api.get).mockReturnValueOnce(invalidated.promise).mockReturnValueOnce(current.promise);
    render(<StrictMode><WishlistPage /></StrictMode>);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await act(async () => { current.resolve(catalog([itemA])); await current.promise; });
    expect(screen.getByText("Item A")).toBeTruthy();
    await act(async () => { invalidated.resolve(catalog([itemB])); await invalidated.promise; });
    expect(screen.getByText("Item A")).toBeTruthy();
    expect(screen.queryByText("Item B")).toBeNull();
  });
});
