// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomerAnalyticsPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Customer analytics page (Sprint 61B - proxy recovery)", () => {
  it("renders real analytics through the customer bridge", async () => {
    vi.spyOn(bridge.customerApi, "statistics").mockResolvedValue({ lifetimeValue: 100, orderCount: 2, averageOrderValue: 50, customerScore: 10 });
    render(await CustomerAnalyticsPage({ params: { id: "c1" } }));
    expect(screen.getByText(/€100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Order count: 2/)).toBeInTheDocument();
  });

  it("renders 'Incomplete' for missing statistics without fabricating values (empty state)", async () => {
    vi.spyOn(bridge.customerApi, "statistics").mockResolvedValue(null);
    render(await CustomerAnalyticsPage({ params: { id: "c1" } }));
    expect(screen.getAllByText(/Incomplete/).length).toBeGreaterThan(0);
  });

  it("renders a graceful error state instead of throwing when the proxy call fails", async () => {
    vi.spyOn(bridge.customerApi, "statistics").mockRejectedValue(new Error("ERP authentication failed"));
    render(await CustomerAnalyticsPage({ params: { id: "c1" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
