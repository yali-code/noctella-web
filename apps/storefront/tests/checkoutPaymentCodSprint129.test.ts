// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckoutPaymentPage from "../src/app/checkout/payment/page";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  getCart: vi.fn(),
  isCashOnDeliveryAvailable: vi.fn(),
  getCheckoutDraft: vi.fn(),
  isCheckoutDraftValid: vi.fn(),
  getOrRebuildOrderDraft: vi.fn(),
  createCashOnDeliveryOrder: vi.fn(),
  saveCreatedOrder: vi.fn(),
  getShippingOptions: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/cart", () => ({ getCart: mocks.getCart, isCashOnDeliveryAvailable: mocks.isCashOnDeliveryAvailable }));
vi.mock("@/lib/checkout", () => ({ getCheckoutDraft: mocks.getCheckoutDraft, isCheckoutDraftValid: mocks.isCheckoutDraftValid }));
vi.mock("@/lib/orderDraft", () => ({ getOrRebuildOrderDraft: mocks.getOrRebuildOrderDraft }));
vi.mock("@/lib/orders", () => ({ createCashOnDeliveryOrder: mocks.createCashOnDeliveryOrder, saveCreatedOrder: mocks.saveCreatedOrder }));
vi.mock("@/lib/shipping", () => ({ getShippingOptions: mocks.getShippingOptions }));

const cart = { items: [{ productId: "product-1", quantity: 1 }] };
const checkoutDraft = { customer: { email: "buyer@example.com" }, shippingAddress: { line1: "1 Test St", city: "Sofia", postalCode: "1000", country: "BG", countryCode: "BG" } };
const freeShippingOption = { shippingMethodId: "free-shipping", label: "Free Shipping", ruleType: "Free", amountEurCents: 0 };
const orderDraft = {
  id: "stable-draft-129",
  customer: { firstName: "Ada", lastName: "Buyer", email: "buyer@example.com", phone: "" },
  shippingAddress: { line1: "1 Test St", line2: "", city: "Sofia", state: "", postalCode: "1000", country: "BG" },
  billingAddress: null,
  customerNote: "COD please",
  items: [{ productId: "product-1", title: "Web Product", priceEur: 100 }],
  currencySummary: { eurSubtotal: 100 },
};
const createdOrder = { id: "order-129", orderNumber: "NOC-129" };

function arrange(codAvailable = true) {
  mocks.getCart.mockReturnValue(cart);
  mocks.getCheckoutDraft.mockReturnValue(checkoutDraft);
  mocks.isCheckoutDraftValid.mockReturnValue(true);
  mocks.getOrRebuildOrderDraft.mockReturnValue(orderDraft);
  mocks.isCashOnDeliveryAvailable.mockReturnValue(codAvailable);
  mocks.createCashOnDeliveryOrder.mockResolvedValue(createdOrder);
  mocks.getShippingOptions.mockResolvedValue({ items: [freeShippingOption] });
}

describe("Sprint 129 COD-only checkout presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    arrange();
  });
  afterEach(cleanup);

  it("renders only the available Cash on Delivery launch action", async () => {
    render(createElement(CheckoutPaymentPage));
    const submit = await screen.findByRole("button", { name: "Place Cash on Delivery Order" });
    expect(screen.getByText("Cash on Delivery")).toBeTruthy();
    expect(screen.queryByText("Stripe")).toBeNull();
    expect(screen.queryByText("PayPal")).toBeNull();
    expect(submit).not.toHaveProperty("disabled", true);
  });

  it("disables submission when COD is unavailable", async () => {
    arrange(false);
    render(createElement(CheckoutPaymentPage));
    expect(await screen.findByText("Not available for the items in your cart.")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Place Cash on Delivery Order" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.click(submit);
    expect(mocks.createCashOnDeliveryOrder).not.toHaveBeenCalled();
  });

  it("submits the active draft once, stores the result, and then navigates", async () => {
    render(createElement(CheckoutPaymentPage));
    await userEvent.click(await screen.findByRole("button", { name: "Place Cash on Delivery Order" }));
    await waitFor(() => expect(mocks.createCashOnDeliveryOrder).toHaveBeenCalledTimes(1));
    expect(mocks.createCashOnDeliveryOrder).toHaveBeenCalledWith(orderDraft, { shippingMethodId: "free-shipping", expectedShippingAmountEur: 0 });
    await waitFor(() => expect(mocks.saveCreatedOrder).toHaveBeenCalledWith(createdOrder));
    expect(mocks.push).toHaveBeenCalledWith("/checkout/success");
  });

  it("prevents a second active submission", async () => {
    let resolve!: (value: typeof createdOrder) => void;
    mocks.createCashOnDeliveryOrder.mockReturnValue(new Promise((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(createElement(CheckoutPaymentPage));
    const submit = await screen.findByRole("button", { name: "Place Cash on Delivery Order" });
    await user.click(submit);
    await waitFor(() => expect(mocks.createCashOnDeliveryOrder).toHaveBeenCalledTimes(1));
    await user.click(submit);
    expect(mocks.createCashOnDeliveryOrder).toHaveBeenCalledTimes(1);
    resolve(createdOrder);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/checkout/success"));
  });

  it("shows failure without saving or navigating", async () => {
    mocks.createCashOnDeliveryOrder.mockRejectedValue(new Error("COD unavailable"));
    render(createElement(CheckoutPaymentPage));
    await userEvent.click(await screen.findByRole("button", { name: "Place Cash on Delivery Order" }));
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeTruthy();
    expect(mocks.saveCreatedOrder).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalledWith("/checkout/success");
  });
});
