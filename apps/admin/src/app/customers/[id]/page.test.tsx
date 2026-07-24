// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomerDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Customer detail page (Sprint 61B - proxy recovery)", () => {
  it("renders real customer data through the customer bridge", async () => {
    vi.spyOn(bridge.customerApi, "detail").mockResolvedValue({ id: "c1", name: "Ada", email: "a***@x.test", phone: "1***6", erpReferenceId: "ERP-1" });
    render(await CustomerDetailPage({ params: { id: "c1" } }));
    expect(screen.getByRole("heading", { name: "Ada" })).toBeInTheDocument();
    expect(screen.getByText(/a\*\*\*@x\.test/)).toBeInTheDocument();
    expect(screen.getByText("Timeline")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing when the proxy call fails", async () => {
    vi.spyOn(bridge.customerApi, "detail").mockRejectedValue(new Error("Customer not found"));
    render(await CustomerDetailPage({ params: { id: "missing" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Customer not found");
  });
});
