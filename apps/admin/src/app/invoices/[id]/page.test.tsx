// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpSalesFinanceBridge";
import InvoiceDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const baseInvoice = (overrides: any = {}) => ({
  id: "inv-1",
  orderId: "order-1",
  invoiceNumber: null,
  invoiceType: "SalesInvoice",
  status: "Draft",
  calculationMode: "Automatic",
  taxTreatment: "StandardVAT",
  pricesIncludeVat: false,
  sellerSnapshot: JSON.stringify({ configured: true, legalName: "Noctella Test Ltd." }),
  customerSnapshot: JSON.stringify({ name: "Jane Collector" }),
  billingAddressSnapshot: JSON.stringify({ line1: "1 Rue Noctella", city: "Paris", country: "FR" }),
  subtotal: 100,
  discountAmount: 0,
  shippingAmount: 0,
  shippingVatRate: 0,
  shippingVatAmount: 0,
  taxVatAmount: 0,
  totalAmount: 100,
  dueAt: null,
  issuedAt: null,
  notes: null,
  invoiceFooter: null,
  lines: [{ id: "line-1", titleSnapshot: "Vintage Clock", quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0, taxVatAmount: 0, lineTotal: 100 }],
  ...overrides,
});

function mockLoad(invoice: any, readiness: any = { ready: true, issues: [] }) {
  vi.spyOn(bridge.invoicesApi, "invoice").mockResolvedValue(invoice);
  vi.spyOn(bridge.invoicesApi, "events").mockResolvedValue({ items: [] });
  vi.spyOn(bridge.invoicesApi, "issueReadiness").mockResolvedValue(readiness);
}

async function renderPage(invoice: any, readiness?: any) {
  mockLoad(invoice, readiness);
  render(<InvoiceDetailPage params={{ id: invoice.id }} />);
  await screen.findByText("order-1");
}

describe("Invoice detail page (Sprint 79)", () => {
  it("renders seller/customer snapshots, lines, and totals for a Draft invoice", async () => {
    await renderPage(baseInvoice());
    expect(screen.getAllByText(/Noctella Test Ltd\./).length).toBeGreaterThan(0);
    expect(screen.getByText(/Jane Collector/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /\(Draft\)/ })).toBeInTheDocument();
  });

  it("shows the not-ready-to-issue reasons when readiness fails", async () => {
    await renderPage(baseInvoice(), { ready: false, issues: ["Company profile is not configured"] });
    expect(await screen.findByText("Company profile is not configured")).toBeInTheDocument();
  });

  it("Issue Invoice calls the real issue action and reloads", async () => {
    const user = userEvent.setup();
    await renderPage(baseInvoice());
    const issueSpy = vi.spyOn(bridge, "issueInvoice").mockResolvedValue({});
    const reloadSpy = vi.spyOn(bridge.invoicesApi, "invoice");
    await user.click(screen.getByText("Issue Invoice"));
    await user.click(screen.getByText("Confirm Issue Invoice"));
    await waitFor(() => expect(issueSpy).toHaveBeenCalledWith("inv-1"));
    await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(2));
  });

  it("Switch calculation mode calls switchInvoiceCalculationMode with ManualOverride", async () => {
    const user = userEvent.setup();
    await renderPage(baseInvoice());
    const switchSpy = vi.spyOn(bridge, "switchInvoiceCalculationMode").mockResolvedValue(baseInvoice({ calculationMode: "ManualOverride" }));
    await user.click(screen.getByText("Switch to Manual Override"));
    await waitFor(() => expect(switchSpy).toHaveBeenCalledWith("inv-1", "ManualOverride"));
  });

  it("Print Invoice triggers window.print", async () => {
    const user = userEvent.setup();
    await renderPage(baseInvoice());
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    await user.click(screen.getByText("Print Invoice"));
    expect(printSpy).toHaveBeenCalled();
  });

  it("an Issued invoice hides Draft-only editing controls and shows Mark Paid / Cancel", async () => {
    await renderPage(baseInvoice({ status: "Issued", invoiceNumber: "NOCT-2026-000001" }));
    expect(screen.queryByText("Issue Invoice")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancel Draft")).not.toBeInTheDocument();
    expect(screen.getByText("Mark Paid")).toBeInTheDocument();
    expect(screen.getByText("Cancel Invoice")).toBeInTheDocument();
  });

  it("does not add a Credit Note button anywhere on the page", async () => {
    await renderPage(baseInvoice({ status: "Issued", invoiceNumber: "NOCT-2026-000001" }));
    expect(screen.queryByText(/Credit Note/i)).not.toBeInTheDocument();
  });
});
