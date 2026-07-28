// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpSalesFinanceBridge";
import InvoicesPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Invoices list page (Sprint 79)", () => {
  it("renders real invoice rows with number, status, and totals", async () => {
    vi.spyOn(bridge.invoicesApi, "list").mockResolvedValue({
      items: [
        { id: "inv-1", orderId: "order-1", invoiceType: "SalesInvoice", status: "Draft", subtotal: 100, taxVatAmount: 20, totalAmount: 120, currency: "EUR", createdAt: "2026-01-01", issuedAt: null },
      ],
    });
    render(<InvoicesPage />);
    expect((await screen.findAllByText("Draft")).length).toBeGreaterThan(0);
    expect(screen.getByText("€120.00")).toBeInTheDocument();
    expect(screen.getByText("SalesInvoice")).toBeInTheDocument();
  });

  it("shows an empty state when there are no invoices", async () => {
    vi.spyOn(bridge.invoicesApi, "list").mockResolvedValue({ items: [] });
    render(<InvoicesPage />);
    expect(await screen.findByText("No invoices found.")).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    vi.spyOn(bridge.invoicesApi, "list").mockRejectedValue(new Error("boom"));
    render(<InvoicesPage />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
