// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomerNotesPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Customer notes page (Sprint 61B - proxy recovery)", () => {
  it("renders real, masked notes through the customer bridge", async () => {
    vi.spyOn(bridge.customerApi, "notes").mockResolvedValue({ items: [{ id: "n1", version: 1, body: "[REDACTED]" }] });
    render(await CustomerNotesPage({ params: { id: "c1" } }));
    expect(screen.getByText(/v1: \[REDACTED\]/)).toBeInTheDocument();
  });

  it("renders an empty state without a raw crash", async () => {
    vi.spyOn(bridge.customerApi, "notes").mockResolvedValue({ items: [] });
    render(await CustomerNotesPage({ params: { id: "c1" } }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Customer Notes")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing when the proxy call fails", async () => {
    vi.spyOn(bridge.customerApi, "notes").mockRejectedValue(new Error("ERP authentication failed"));
    render(await CustomerNotesPage({ params: { id: "c1" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
