// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import * as bridge from "@/lib/erpPurchasingBridge";
import SupplierDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const supplierRow = { id: "s1", name: "Acme Dealer", status: "Active", supplierType: "Dealer", countryCode: "BE", city: "Brussels", erpReferenceId: "erp-1", purchaseCount: 2, lastPurchaseAt: "2026-01-01", updatedAt: "2026-01-01T00:00:00.000Z" };

async function renderPage(overrides: any = {}, purchases: any[] = []) {
  vi.spyOn(bridge.purchasingApi, "supplier").mockResolvedValue({ ...supplierRow, ...overrides });
  vi.spyOn(bridge.purchasingApi, "purchases").mockResolvedValue({ items: purchases });
  render(<SupplierDetailPage params={{ id: "s1" }} />);
  await screen.findByRole("heading", { name: "Acme Dealer" });
}

describe("Supplier detail page (Sprint 57B)", () => {
  it("renders real supplier fields and related purchases", async () => {
    await renderPage({}, [{ id: "p1", supplierId: "s1", status: "Draft", sourceType: "Auction", totalCost: 20 }]);
    expect(screen.getByText(/Active/)).toBeInTheDocument();
    expect(screen.getByText(/erp-1/)).toBeInTheDocument();
    expect(screen.getByText("€20.00")).toBeInTheDocument();
  });

  it("renders an empty related-purchases state when none exist", async () => {
    await renderPage();
    await screen.findByText("No purchases recorded for this supplier yet.");
  });

  it("updates a supplier, forwarding the current updatedAt, and reloads after success", async () => {
    const user = userEvent.setup();
    await renderPage();
    const updateSpy = vi.spyOn(bridge, "updateSupplier").mockResolvedValue({});
    await user.click(screen.getByText("Edit"));
    const nameInput = screen.getByDisplayValue("Acme Dealer");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Dealer");
    await user.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith("s1", expect.objectContaining({ name: "Renamed Dealer" }), "2026-01-01T00:00:00.000Z"));
    await screen.findByText("Supplier updated.");
  });

  it("shows a clear conflict message on a 409 (supplier changed since load), not a fabricated version field", async () => {
    const user = userEvent.setup();
    await renderPage();
    vi.spyOn(bridge, "updateSupplier").mockRejectedValue(new ApiError("Supplier has changed since expectedUpdatedAt", 409));
    await user.click(screen.getByText("Edit"));
    await user.click(screen.getByText("Save"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/changed by someone else since it was loaded/);
  });

  it("renders a load error state", async () => {
    vi.spyOn(bridge.purchasingApi, "supplier").mockRejectedValue(new Error("Supplier not found"));
    render(<SupplierDetailPage params={{ id: "missing" }} />);
    await screen.findByText("Supplier not found");
  });
});
