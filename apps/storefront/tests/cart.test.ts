import { beforeEach, describe, expect, it } from "vitest";
import {
  addCartItem,
  addToCartPersisted,
  type CartItem,
  cartEurSubtotal,
  cartHasItem,
  cartItemCount,
  cartUsdSubtotal,
  clearCartItems,
  clearCartPersisted,
  getCart,
  removeCartItem,
  removeFromCartPersisted,
} from "../src/lib/cart";

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

function uniqueItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: "product-1",
    slug: "vintage-watch",
    title: "Vintage Watch",
    primaryImageUrl: "https://example.com/watch.jpg",
    eurPrice: 500,
    quantity: 1,
    productType: "unique_item",
    ...overrides,
  };
}

describe("cart pure logic", () => {
  it("adds an item", () => {
    const result = addCartItem([], uniqueItem());
    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe("product-1");
  });

  it("removes an item", () => {
    const items = addCartItem([], uniqueItem());
    const result = removeCartItem(items, "product-1");
    expect(result).toHaveLength(0);
  });

  it("clears the cart", () => {
    expect(clearCartItems()).toEqual([]);
  });

  it("prevents duplicate product rows", () => {
    let items = addCartItem([], uniqueItem());
    items = addCartItem(items, uniqueItem());
    expect(items).toHaveLength(1);
  });

  it("caps Unique Item quantity at 1", () => {
    const result = addCartItem([], uniqueItem({ quantity: 5, productType: "unique_item" }));
    expect(result[0].quantity).toBe(1);
  });

  it("caps Lot Item quantity at 1", () => {
    const result = addCartItem([], uniqueItem({ quantity: 5, productType: "lot_item" }));
    expect(result[0].quantity).toBe(1);
  });

  it("defaults quantity to 1 when omitted/zero", () => {
    const result = addCartItem([], uniqueItem({ quantity: 0 }));
    expect(result[0].quantity).toBe(1);
  });

  it("reports whether an item exists in the cart", () => {
    const items = addCartItem([], uniqueItem());
    expect(cartHasItem(items, "product-1")).toBe(true);
    expect(cartHasItem(items, "product-2")).toBe(false);
  });

  it("calculates item count", () => {
    let items = addCartItem([], uniqueItem());
    items = addCartItem(items, uniqueItem({ productId: "product-2", slug: "pen" }));
    expect(cartItemCount(items)).toBe(2);
  });

  it("calculates EUR subtotal", () => {
    let items = addCartItem([], uniqueItem({ eurPrice: 500 }));
    items = addCartItem(items, uniqueItem({ productId: "product-2", eurPrice: 250 }));
    expect(cartEurSubtotal(items)).toBe(750);
  });

  it("calculates USD subtotal only when every item has a USD price", () => {
    let items = addCartItem([], uniqueItem({ eurPrice: 500, usdPrice: 550 }));
    items = addCartItem(items, uniqueItem({ productId: "product-2", eurPrice: 250, usdPrice: 275 }));
    expect(cartUsdSubtotal(items)).toBe(825);
  });

  it("returns undefined USD subtotal when any item is missing a USD price", () => {
    let items = addCartItem([], uniqueItem({ eurPrice: 500, usdPrice: 550 }));
    items = addCartItem(items, uniqueItem({ productId: "product-2", eurPrice: 250 }));
    expect(cartUsdSubtotal(items)).toBeUndefined();
  });

  it("returns undefined USD subtotal for an empty cart", () => {
    expect(cartUsdSubtotal([])).toBeUndefined();
  });
});

describe("cart localStorage persistence", () => {
  beforeEach(() => {
    // @ts-expect-error -- assigning a minimal browser-like global for the test
    global.window = { localStorage: new MemoryStorage() };
  });

  it("persists an added item across reads (simulated reload)", () => {
    addToCartPersisted(uniqueItem());
    expect(getCart()).toHaveLength(1);
    expect(getCart()[0].productId).toBe("product-1");
  });

  it("removes an item and persists the removal", () => {
    addToCartPersisted(uniqueItem());
    removeFromCartPersisted("product-1");
    expect(getCart()).toEqual([]);
  });

  it("clears the cart and persists the change", () => {
    addToCartPersisted(uniqueItem());
    clearCartPersisted();
    expect(getCart()).toEqual([]);
  });

  it("prevents duplicates via the persisted wrapper", () => {
    addToCartPersisted(uniqueItem());
    addToCartPersisted(uniqueItem());
    expect(getCart()).toHaveLength(1);
  });

  it("handles corrupt localStorage JSON safely, returning an empty cart", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_cart",
      "{not valid json",
    );
    expect(getCart()).toEqual([]);
  });

  it("ignores invalid stored entries while keeping valid ones", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_cart",
      JSON.stringify([
        { productId: "product-1", slug: "a", title: "A", eurPrice: 100, quantity: 1, productType: "unique_item" },
        { productId: "product-2" },
        "not-an-object",
        null,
      ]),
    );
    const cart = getCart();
    expect(cart).toHaveLength(1);
    expect(cart[0].productId).toBe("product-1");
  });

  it("de-duplicates stored entries with the same productId on read", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_cart",
      JSON.stringify([
        { productId: "product-1", slug: "a", title: "A", eurPrice: 100, quantity: 1, productType: "unique_item" },
        { productId: "product-1", slug: "a", title: "A duplicate", eurPrice: 100, quantity: 1, productType: "unique_item" },
      ]),
    );
    expect(getCart()).toHaveLength(1);
  });

  it("returns an empty cart when window is undefined (server-side render safety)", () => {
    // @ts-expect-error -- simulate SSR where window doesn't exist
    global.window = undefined;
    expect(getCart()).toEqual([]);
  });
});
