import { beforeEach, describe, expect, it } from "vitest";
import type { CartItem } from "../src/lib/cart";
import { isCashOnDeliveryAvailable } from "../src/lib/cart";
import {
  clearPaymentSelection,
  getPaymentActionState,
  getPaymentSelection,
  getPaymentSelectionForDraft,
  savePaymentSelection,
  updatePaymentSelectionStatus,
} from "../src/lib/paymentSelection";

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
    eurPrice: 500,
    quantity: 1,
    productType: "unique_item",
    ...overrides,
  };
}

describe("cash on delivery availability", () => {
  it("is available when every cart item allows it", () => {
    const items = [cartItem({ allowCashOnDelivery: true }), cartItem({ productId: "p2", allowCashOnDelivery: true })];
    expect(isCashOnDeliveryAvailable(items)).toBe(true);
  });

  it("is unavailable when any cart item disallows it", () => {
    const items = [cartItem({ allowCashOnDelivery: true }), cartItem({ productId: "p2", allowCashOnDelivery: false })];
    expect(isCashOnDeliveryAvailable(items)).toBe(false);
  });

  it("is unavailable when a cart item omits the field", () => {
    const items = [cartItem({ allowCashOnDelivery: true }), cartItem({ productId: "p2" })];
    expect(isCashOnDeliveryAvailable(items)).toBe(false);
  });

  it("is unavailable for an empty cart", () => {
    expect(isCashOnDeliveryAvailable([])).toBe(false);
  });
});

describe("payment selection persistence", () => {
  beforeEach(() => {
    // @ts-expect-error -- assigning a minimal browser-like global for the test
    global.window = { localStorage: new MemoryStorage() };
  });

  it("saves and reads back a payment selection", () => {
    savePaymentSelection("draft-1", "stripe");
    const selection = getPaymentSelection();
    expect(selection?.orderDraftId).toBe("draft-1");
    expect(selection?.provider).toBe("stripe");
  });

  it("restores the selection after a simulated reload", () => {
    savePaymentSelection("draft-1", "paypal");
    const restored = getPaymentSelectionForDraft("draft-1");
    expect(restored?.provider).toBe("paypal");
  });

  it("resets (returns null) when the orderDraftId changes", () => {
    savePaymentSelection("draft-1", "stripe");
    const result = getPaymentSelectionForDraft("draft-2");
    expect(result).toBeNull();
  });

  it("handles corrupt JSON safely, returning null", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_payment_selection",
      "{not valid json",
    );
    expect(getPaymentSelection()).toBeNull();
  });

  it("handles an invalid stored shape safely", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_payment_selection",
      JSON.stringify({ provider: "bitcoin" }),
    );
    expect(getPaymentSelection()).toBeNull();
  });

  it("clears the stored selection", () => {
    savePaymentSelection("draft-1", "cash_on_delivery");
    clearPaymentSelection();
    expect(getPaymentSelection()).toBeNull();
  });

  it("stores the mock initialize response alongside the selection", () => {
    savePaymentSelection("draft-1", "stripe", { providerReference: "mock_stripe_draft-1", status: "pending" });
    const selection = getPaymentSelection();
    expect(selection?.providerReference).toBe("mock_stripe_draft-1");
    expect(selection?.status).toBe("pending");
  });

  it("updates only the status of the stored selection", () => {
    savePaymentSelection("draft-1", "stripe", { providerReference: "mock_stripe_draft-1", status: "pending" });
    updatePaymentSelectionStatus("paid");
    const selection = getPaymentSelection();
    expect(selection?.status).toBe("paid");
    expect(selection?.providerReference).toBe("mock_stripe_draft-1");
  });

  it("returns null when updating status with no stored selection", () => {
    expect(updatePaymentSelectionStatus("paid")).toBeNull();
  });
});

describe("getPaymentActionState", () => {
  it("allows verify and cancel when pending", () => {
    expect(getPaymentActionState("pending")).toEqual({ canVerify: true, canCancel: true, isFinal: false });
  });

  it("allows retry verify but not cancel when failed", () => {
    expect(getPaymentActionState("failed")).toEqual({ canVerify: true, canCancel: false, isFinal: false });
  });

  it("disables all actions when paid", () => {
    expect(getPaymentActionState("paid")).toEqual({ canVerify: false, canCancel: false, isFinal: true });
  });

  it("disables all actions when cancelled", () => {
    expect(getPaymentActionState("cancelled")).toEqual({ canVerify: false, canCancel: false, isFinal: true });
  });

  it("offers no actions for a missing status", () => {
    expect(getPaymentActionState(undefined)).toEqual({ canVerify: false, canCancel: false, isFinal: false });
  });

  it("offers no actions for an invalid/unrecognized status", () => {
    expect(getPaymentActionState("some-garbage-status")).toEqual({
      canVerify: false,
      canCancel: false,
      isFinal: false,
    });
  });
});
