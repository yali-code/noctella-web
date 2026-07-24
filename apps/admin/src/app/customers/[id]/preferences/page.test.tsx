// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomerPreferencesPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Customer preferences page (Sprint 61B - proxy recovery)", () => {
  it("renders real preferences through the customer bridge", async () => {
    vi.spyOn(bridge.customerApi, "preferences").mockResolvedValue({ language: "en", currency: "EUR", preferredMarketplace: "ebay" });
    render(await CustomerPreferencesPage({ params: { id: "c1" } }));
    expect(screen.getByText(/Language: en/)).toBeInTheDocument();
    expect(screen.getByText(/Currency: EUR/)).toBeInTheDocument();
  });

  it("renders 'Incomplete' for missing preferences without fabricating values (empty state)", async () => {
    vi.spyOn(bridge.customerApi, "preferences").mockResolvedValue(null);
    render(await CustomerPreferencesPage({ params: { id: "c1" } }));
    expect(screen.getAllByText(/Incomplete/).length).toBe(3);
  });

  it("renders a graceful error state instead of throwing when the proxy call fails", async () => {
    vi.spyOn(bridge.customerApi, "preferences").mockRejectedValue(new Error("ERP authentication failed"));
    render(await CustomerPreferencesPage({ params: { id: "c1" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
