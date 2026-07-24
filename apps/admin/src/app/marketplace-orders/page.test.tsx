// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/marketplaceSync";
import MarketplaceOrdersPage from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => vi.restoreAllMocks());

const retryableOrder = { id: "m1", channel: "ebay", externalOrderId: "e1", total: 10, currency: "EUR", status: "paid", retryable: true, attemptCount: 0 };
const importedOrder = { id: "m2", channel: "ebay", externalOrderId: "e2", total: 10, currency: "EUR", status: "paid", internalOrderId: "o1", retryable: true, attemptCount: 0 };

describe("Marketplace orders list page (Sprint 63B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge, "listMarketplaceOrders").mockResolvedValue({ items: [retryableOrder] });
    render(await MarketplaceOrdersPage({ searchParams: {} }));
    expect(screen.getByText("e1")).toBeInTheDocument();
  });

  it("renders an empty state without a raw crash", async () => {
    vi.spyOn(bridge, "listMarketplaceOrders").mockResolvedValue({ items: [] });
    render(await MarketplaceOrdersPage({ searchParams: {} }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Marketplace Orders")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "listMarketplaceOrders").mockRejectedValue(new Error("ERP authentication failed"));
    render(await MarketplaceOrdersPage({ searchParams: {} }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });

  it("shows Retry only for orders where retryEligible is true", async () => {
    vi.spyOn(bridge, "listMarketplaceOrders").mockResolvedValue({ items: [retryableOrder, importedOrder] });
    render(await MarketplaceOrdersPage({ searchParams: {} }));
    expect(screen.getAllByText("Retry")).toHaveLength(1);
  });

  it("retries an order and reloads authoritative data on success, preventing duplicate submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "listMarketplaceOrders").mockResolvedValue({ items: [retryableOrder] });
    let resolveRetry!: (v: any) => void;
    const retrySpy = vi.spyOn(bridge, "retryMarketplaceOrder").mockReturnValue(new Promise((resolve) => { resolveRetry = resolve; }));
    render(await MarketplaceOrdersPage({ searchParams: {} }));
    await user.click(screen.getByText("Retry"));
    expect(screen.getByText("Retrying…")).toBeDisabled();
    await user.click(screen.getByText("Retrying…"));
    expect(retrySpy).toHaveBeenCalledTimes(1);
    resolveRetry({});
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText("Retried.")).toBeInTheDocument();
  });

  it("shows a structured error when retry fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "listMarketplaceOrders").mockResolvedValue({ items: [retryableOrder] });
    vi.spyOn(bridge, "retryMarketplaceOrder").mockRejectedValue(new Error("Marketplace order is not retryable"));
    render(await MarketplaceOrdersPage({ searchParams: {} }));
    await user.click(screen.getByText("Retry"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Marketplace order is not retryable");
  });
});
