import { beforeEach, describe, expect, it } from "vitest";
import {
  addToWishlist,
  removeFromWishlist,
  toggleWishlist,
  isInWishlist,
  getWishlistIds,
  toggleWishlistPersisted,
} from "../src/lib/wishlist";

/** Minimal in-memory localStorage mock — avoids pulling in a full jsdom dependency. */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe("wishlist pure logic", () => {
  it("adds a product to the wishlist", () => {
    const result = addToWishlist([], "product-1");
    expect(result).toEqual(["product-1"]);
  });

  it("prevents duplicates when adding", () => {
    const result = addToWishlist(["product-1"], "product-1");
    expect(result).toEqual(["product-1"]);
  });

  it("removes a product from the wishlist", () => {
    const result = removeFromWishlist(["product-1", "product-2"], "product-1");
    expect(result).toEqual(["product-2"]);
  });

  it("toggle adds when absent and removes when present", () => {
    const added = toggleWishlist([], "product-1");
    expect(added).toEqual(["product-1"]);
    const removed = toggleWishlist(added, "product-1");
    expect(removed).toEqual([]);
  });

  it("reports whether a product is in the wishlist", () => {
    expect(isInWishlist(["product-1"], "product-1")).toBe(true);
    expect(isInWishlist(["product-1"], "product-2")).toBe(false);
  });
});

describe("wishlist localStorage persistence", () => {
  beforeEach(() => {
    // @ts-expect-error -- assigning a minimal browser-like global for the test
    global.window = { localStorage: new MemoryStorage() };
  });

  it("persists an added product across reads (simulated reload)", () => {
    toggleWishlistPersisted("product-1");
    // Simulate a page reload: re-reading getWishlistIds() should reflect the same underlying storage.
    expect(getWishlistIds()).toEqual(["product-1"]);
  });

  it("removes a product on second toggle and persists the removal", () => {
    toggleWishlistPersisted("product-1");
    toggleWishlistPersisted("product-1");
    expect(getWishlistIds()).toEqual([]);
  });

  it("prevents duplicate entries via the persisted wrapper", () => {
    toggleWishlistPersisted("product-1");
    toggleWishlistPersisted("product-2");
    expect(getWishlistIds().filter((id) => id === "product-1")).toHaveLength(1);
    expect(getWishlistIds()).toEqual(["product-1", "product-2"]);
  });

  it("handles corrupt localStorage data safely, returning an empty list", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_wishlist",
      "{not valid json",
    );
    expect(getWishlistIds()).toEqual([]);
  });

  it("handles non-array JSON in localStorage safely, returning an empty list", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_wishlist",
      JSON.stringify({ not: "an array" }),
    );
    expect(getWishlistIds()).toEqual([]);
  });

  it("returns an empty list when window is undefined (server-side render safety)", () => {
    // @ts-expect-error -- simulate SSR where window doesn't exist
    global.window = undefined;
    expect(getWishlistIds()).toEqual([]);
  });
});
