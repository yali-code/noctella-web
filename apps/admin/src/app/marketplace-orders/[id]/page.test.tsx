// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/marketplaceSync";
import MarketplaceOrderDetail from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => vi.restoreAllMocks());

const baseOrder = (overrides: any = {}) => ({ id: "m1", channel: "ebay", externalOrderId: "e1", total: 10, currency: "EUR", status: "paid", retryable: true, attemptCount: 0, items: [{ id: "i1", titleSnapshot: "Lamp", quantity: 1, productId: "p1" }], rawPayloadSnapshot: {}, ...overrides });

describe("Marketplace order detail page (Sprint 63B)", () => {
  it("renders real order data", async () => {
    vi.spyOn(bridge, "getMarketplaceOrder").mockResolvedValue(baseOrder());
    render(await MarketplaceOrderDetail({ params: { id: "m1" } }));
    expect(screen.getByText(/Marketplace Order e1/)).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "getMarketplaceOrder").mockRejectedValue(new Error("Marketplace order not found"));
    render(await MarketplaceOrderDetail({ params: { id: "missing" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Marketplace order not found");
  });

  it("shows Retry only when retryEligible is true", async () => {
    vi.spyOn(bridge, "getMarketplaceOrder").mockResolvedValue(baseOrder({ internalOrderId: "o1" }));
    render(await MarketplaceOrderDetail({ params: { id: "m1" } }));
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("retries the order and reloads authoritative data on success", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getMarketplaceOrder").mockResolvedValue(baseOrder());
    const retrySpy = vi.spyOn(bridge, "retryMarketplaceOrder").mockResolvedValue({} as any);
    render(await MarketplaceOrderDetail({ params: { id: "m1" } }));
    await user.click(screen.getByText("Retry"));
    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith("m1"));
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Retried.")).toBeInTheDocument();
  });

  it("shows a structured error when retry fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getMarketplaceOrder").mockResolvedValue(baseOrder());
    vi.spyOn(bridge, "retryMarketplaceOrder").mockRejectedValue(new Error("Marketplace order is not retryable"));
    render(await MarketplaceOrderDetail({ params: { id: "m1" } }));
    await user.click(screen.getByText("Retry"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Marketplace order is not retryable");
  });
});
