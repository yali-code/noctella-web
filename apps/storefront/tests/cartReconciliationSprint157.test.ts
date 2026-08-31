import { describe, expect, it } from "vitest";
import { buildCartReconciliation } from "../src/lib/cartReconciliation";
import type { CartItem } from "../src/lib/cart";

const previous: CartItem[] = [
  { productId: "p-1", slug: "old-one", title: "Old One", primaryImageUrl: "/old.jpg", eurPrice: 100, usdPrice: 110, quantity: 1, productType: "unique_item", allowCashOnDelivery: true },
  { productId: "p-2", slug: "old-two", title: "Old Two", eurPrice: 50, quantity: 1, productType: "unique_item", allowCashOnDelivery: true },
];

describe("Sprint 157 cart reconciliation", () => {
  it("refreshes presentation in stable cart order without requiring consent", () => {
    const result = buildCartReconciliation(previous, { items: [
      { productId: "p-2", availability: "available", slug: "new-two", title: "New Two", primaryImageUrl: "/two.jpg", priceEur: 50, productType: "unique_item", allowCashOnDelivery: true },
      { productId: "p-1", availability: "available", slug: "new-one", title: "New One", primaryImageUrl: "/one.jpg", priceEur: 100, priceUsd: 111, productType: "unique_item", allowCashOnDelivery: true },
    ] });
    expect(result.currentItems.map((item) => item.productId)).toEqual(["p-1", "p-2"]);
    expect(result.currentItems[0]).toMatchObject({ slug: "new-one", title: "New One", primaryImageUrl: "/one.jpg", usdPrice: 111 });
    expect(result.changes).toEqual([]);
  });

  it.each([[125, 100, 125], [75, 100, 75]])("requires review for price changes to %s", (priceEur, oldPrice, newPrice) => {
    const result = buildCartReconciliation([previous[0]], { items: [
      { productId: "p-1", availability: "available", slug: "one", title: "One", priceEur, productType: "unique_item", allowCashOnDelivery: true },
    ] });
    expect(result.changes).toEqual([{ productId: "p-1", title: "One", previousPriceEur: oldPrice, currentPriceEur: newPrice, codEligibilityChanged: false }]);
  });

  it("requires review for COD eligibility changes and retains unavailable lines", () => {
    const result = buildCartReconciliation(previous, { items: [
      { productId: "p-1", availability: "available", slug: "one", title: "One", priceEur: 100, productType: "unique_item", allowCashOnDelivery: false },
      { productId: "p-2", availability: "unavailable", reason: "out_of_stock" },
    ] });
    expect(result.changes[0]).toMatchObject({ productId: "p-1", codEligibilityChanged: true });
    expect(result.unavailableItems).toEqual([{ productId: "p-2", title: "Old Two", reason: "out_of_stock" }]);
    expect(result.currentItems[1]).toEqual(previous[1]);
  });
});
