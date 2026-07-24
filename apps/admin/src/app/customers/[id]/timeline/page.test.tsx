// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomerTimelinePage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Customer timeline page (Sprint 61B - proxy recovery)", () => {
  it("renders real timeline entries through the customer bridge, exactly as returned", async () => {
    vi.spyOn(bridge.customerApi, "history").mockResolvedValue({ items: [{ type: "Order", entityId: "o1", occurredAt: "2026-01-01T00:00:00.000Z", readOnly: true }], readOnly: true });
    render(await CustomerTimelinePage({ params: { id: "c1" } }));
    expect(screen.getByText(/Order o1/)).toBeInTheDocument();
  });

  it("renders an empty state without a raw crash and without hiding an empty history behind a fake message", async () => {
    vi.spyOn(bridge.customerApi, "history").mockResolvedValue({ items: [], readOnly: true });
    render(await CustomerTimelinePage({ params: { id: "c1" } }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Customer Timeline")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing when the proxy call fails", async () => {
    vi.spyOn(bridge.customerApi, "history").mockRejectedValue(new Error("ERP authentication failed"));
    render(await CustomerTimelinePage({ params: { id: "c1" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
