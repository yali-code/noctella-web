// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CheckoutPage from "../app/checkout/page";
import CheckoutReviewPage from "../app/checkout/review/page";
import CheckoutPaymentPage from "../app/checkout/payment/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/CartFreshness", () => ({
  useCartFreshness: () => ({ items: [], loading: true, error: false, result: null, canProceed: false, reconcileNow: vi.fn(), acceptChanges: vi.fn(), removeUnavailable: vi.fn(), retry: vi.fn() }),
  CartFreshnessBlocker: ({ title }: { title: string }) => createElement("div", { "data-testid": "freshness-gate" }, title),
}));

describe("Sprint 157 checkout deep-link freshness gates", () => {
  afterEach(cleanup);

  it.each([
    [CheckoutPage, "Checkout"],
    [CheckoutReviewPage, "Review Order"],
    [CheckoutPaymentPage, "Payment"],
  ])("blocks a direct route until reconciliation succeeds", (Page, title) => {
    render(createElement(Page));
    expect(screen.getByTestId("freshness-gate").textContent).toBe(title);
    expect(screen.queryByRole("button", { name: /continue|place/i })).toBeNull();
  });
});
