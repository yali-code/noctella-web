import { beforeEach, describe, expect, it } from "vitest";
import type { CartItem } from "../src/lib/cart";
import type { CheckoutDraft } from "../src/lib/checkout";
import { buildOrderDraft, getOrderDraft, saveOrderDraft } from "../src/lib/orderDraft";

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

function cartItem(overrides: Partial<CartItem> = {}): CartItem {
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

function validCheckoutDraft(overrides: Partial<CheckoutDraft> = {}): CheckoutDraft {
  return {
    contact: { email: "buyer@example.com" },
    customer: { firstName: "Jane", lastName: "Collector" },
    shippingAddress: {
      line1: "1 Rue de Paris",
      city: "Paris",
      postalCode: "75001",
      country: "France",
      countryCode: "FR",
    },
    billingSameAsShipping: true,
    updatedAt: "",
    ...overrides,
  };
}

describe("buildOrderDraft", () => {
  it("creates an order draft from a valid cart and checkout draft", () => {
    const draft = buildOrderDraft([cartItem()], validCheckoutDraft(), null);
    expect(draft).not.toBeNull();
    expect(draft?.status).toBe("draft");
    expect(draft?.customer.email).toBe("buyer@example.com");
    expect(draft?.items).toHaveLength(1);
  });

  it("keeps a stable id when nothing changed (simulated refresh)", () => {
    const first = buildOrderDraft([cartItem()], validCheckoutDraft(), null)!;
    const second = buildOrderDraft([cartItem()], validCheckoutDraft(), first);
    expect(second?.id).toBe(first.id);
    expect(second?.createdAt).toBe(first.createdAt);
  });

  it("rebuilds (new id) when the cart changes", () => {
    const first = buildOrderDraft([cartItem()], validCheckoutDraft(), null)!;
    const second = buildOrderDraft(
      [cartItem(), cartItem({ productId: "product-2", slug: "pen" })],
      validCheckoutDraft(),
      first,
    );
    expect(second?.id).not.toBe(first.id);
  });

  it("rebuilds (new id) when checkout details change", () => {
    const first = buildOrderDraft([cartItem()], validCheckoutDraft(), null)!;
    const second = buildOrderDraft(
      [cartItem()],
      validCheckoutDraft({ customer: { firstName: "John", lastName: "Collector" } }),
      first,
    );
    expect(second?.id).not.toBe(first.id);
  });

  it("uses billingSameAsShipping and omits a separate billing address", () => {
    const draft = buildOrderDraft([cartItem()], validCheckoutDraft({ billingSameAsShipping: true }), null);
    expect(draft?.billingSameAsShipping).toBe(true);
    expect(draft?.billingAddress).toBeUndefined();
  });

  it("includes a separate billing address when billingSameAsShipping is false", () => {
    const draft = buildOrderDraft(
      [cartItem()],
      validCheckoutDraft({
        billingSameAsShipping: false,
        billingAddress: {
          line1: "2 Oxford Street",
          city: "London",
          postalCode: "W1D 1BS",
          country: "United Kingdom",
          countryCode: "GB",
        },
      }),
      null,
    );
    expect(draft?.billingSameAsShipping).toBe(false);
    expect(draft?.billingAddress?.city).toBe("London");
  });

  it("returns null when the cart is empty", () => {
    const draft = buildOrderDraft([], validCheckoutDraft(), null);
    expect(draft).toBeNull();
  });

  it("returns null when the checkout draft is missing", () => {
    const draft = buildOrderDraft([cartItem()], null, null);
    expect(draft).toBeNull();
  });

  it("returns null when the checkout draft is invalid", () => {
    const draft = buildOrderDraft(
      [cartItem()],
      validCheckoutDraft({ contact: { email: "not-an-email" } }),
      null,
    );
    expect(draft).toBeNull();
  });

  it("computes the EUR subtotal", () => {
    const draft = buildOrderDraft(
      [cartItem({ eurPrice: 500 }), cartItem({ productId: "p2", eurPrice: 250 })],
      validCheckoutDraft(),
      null,
    );
    expect(draft?.currencySummary.eurSubtotal).toBe(750);
  });

  it("computes the USD subtotal only when fully available", () => {
    const draftWithUsd = buildOrderDraft(
      [cartItem({ eurPrice: 500, usdPrice: 550 }), cartItem({ productId: "p2", eurPrice: 250, usdPrice: 275 })],
      validCheckoutDraft(),
      null,
    );
    expect(draftWithUsd?.currencySummary.usdSubtotal).toBe(825);

    const draftPartialUsd = buildOrderDraft(
      [cartItem({ eurPrice: 500, usdPrice: 550 }), cartItem({ productId: "p2", eurPrice: 250 })],
      validCheckoutDraft(),
      null,
    );
    expect(draftPartialUsd?.currencySummary.usdSubtotal).toBeUndefined();
  });
});

describe("order draft persistence", () => {
  beforeEach(() => {
    // @ts-expect-error -- assigning a minimal browser-like global for the test
    global.window = { localStorage: new MemoryStorage() };
  });

  it("saves and reads back an order draft", () => {
    const draft = buildOrderDraft([cartItem()], validCheckoutDraft(), null)!;
    saveOrderDraft(draft);
    expect(getOrderDraft()?.id).toBe(draft.id);
  });

  it("handles corrupt order-draft JSON safely, returning null", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_order_draft",
      "{not valid json",
    );
    expect(getOrderDraft()).toBeNull();
  });

  it("handles an invalid/incomplete stored shape safely", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_order_draft",
      JSON.stringify({ id: "abc" }),
    );
    expect(getOrderDraft()).toBeNull();
  });

  it("returns null when window is undefined (server-side render safety)", () => {
    // @ts-expect-error -- simulate SSR where window doesn't exist
    global.window = undefined;
    expect(getOrderDraft()).toBeNull();
  });
});
