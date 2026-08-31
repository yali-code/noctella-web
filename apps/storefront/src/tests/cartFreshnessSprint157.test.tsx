// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartFreshnessBlocker, useCartFreshness } from "../components/CartFreshness";
import { getCart, replaceCartPersisted, type CartItem } from "../lib/cart";

const mocks = vi.hoisted(() => ({ reconcileCart: vi.fn() }));
vi.mock("@/lib/cartReconciliation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/cartReconciliation")>(),
  reconcileCart: mocks.reconcileCart,
}));

const oldItem: CartItem = { productId: "p-157", slug: "old", title: "Old title", eurPrice: 100, quantity: 1, productType: "unique_item", allowCashOnDelivery: true };
const newItem: CartItem = { ...oldItem, slug: "new", title: "Current title", eurPrice: 125 };

function Harness() {
  const freshness = useCartFreshness();
  return createElement(CartFreshnessBlocker, { freshness, title: "Fresh cart required" });
}

describe("Sprint 157 cart freshness consent UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    replaceCartPersisted([oldItem]);
  });
  afterEach(cleanup);

  it("shows old and current price and persists only after explicit acceptance", async () => {
    mocks.reconcileCart.mockResolvedValue({ previousItems: [oldItem], currentItems: [newItem], changes: [{ productId: oldItem.productId, title: newItem.title, previousPriceEur: 100, currentPriceEur: 125, codEligibilityChanged: false }], unavailableItems: [] });
    render(createElement(Harness));
    expect(await screen.findByText("Price changed from €100.00 to €125.00.")).toBeTruthy();
    expect(getCart()[0]).toMatchObject({ title: "Old title", eurPrice: 100 });
    await userEvent.click(screen.getByRole("button", { name: "Review updated cart" }));
    await waitFor(() => expect(getCart()[0]).toMatchObject({ title: "Current title", eurPrice: 125 }));
  });

  it("keeps an unavailable item visible until removal", async () => {
    mocks.reconcileCart.mockResolvedValueOnce({ previousItems: [oldItem], currentItems: [oldItem], changes: [], unavailableItems: [{ productId: oldItem.productId, title: oldItem.title, reason: "out_of_stock" }] }).mockResolvedValueOnce({ previousItems: [], currentItems: [], changes: [], unavailableItems: [] });
    render(createElement(Harness));
    expect((await screen.findByRole("alert")).textContent).toContain("Old title is out of stock");
    expect(getCart()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Remove Old title" }));
    await waitFor(() => expect(getCart()).toEqual([]));
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledTimes(2));
  });

  it("distinguishes a refresh failure and permits retry", async () => {
    const retry = vi.fn();
    render(createElement(CartFreshnessBlocker, { freshness: { items: [oldItem], loading: false, error: true, result: null, canProceed: false, reconcileNow: vi.fn(), acceptChanges: vi.fn(), removeUnavailable: vi.fn(), retry }, title: "Fresh cart required" }));
    expect(screen.getByRole("alert").textContent).toContain("We could not refresh your cart");
    await userEvent.click(screen.getByRole("button", { name: "Retry cart check" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
