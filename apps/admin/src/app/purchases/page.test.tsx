// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpPurchasingBridge";
import PurchasesPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const supplierRow = { id: "s1", name: "Acme Dealer", status: "Active", supplierType: "Dealer", erpReferenceId: "erp-1" };
const purchaseRow = { id: "p1", supplierId: "s1", status: "Draft", sourceType: "Auction", totalCost: 42, erpReferenceId: "po-1" };

function mockLoad(overrides: { purchases?: any[]; suppliers?: any[] } = {}) {
  vi.spyOn(bridge.purchasingApi, "purchases").mockResolvedValue({ items: overrides.purchases ?? [purchaseRow] });
  vi.spyOn(bridge.purchasingApi, "suppliers").mockResolvedValue({ items: overrides.suppliers ?? [supplierRow] });
}

describe("Purchases list page (Sprint 57B)", () => {
  it("renders real rows with supplier name resolved from the suppliers list", async () => {
    mockLoad();
    render(<PurchasesPage />);
    await screen.findByText("Acme Dealer");
    expect(screen.getByText("Auction")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Draft" })).toBeInTheDocument();
    expect(screen.getByText("€42.00")).toBeInTheDocument();
  });

  it("renders an empty state when there are no purchases", async () => {
    mockLoad({ purchases: [] });
    render(<PurchasesPage />);
    await screen.findByText(/No purchases match/);
  });

  it("renders an error state without fabricating rows", async () => {
    vi.spyOn(bridge.purchasingApi, "purchases").mockRejectedValue(new Error("ERP authentication failed"));
    vi.spyOn(bridge.purchasingApi, "suppliers").mockResolvedValue({ items: [] });
    render(<PurchasesPage />);
    await screen.findByText("ERP authentication failed");
  });

  it("opens the create-purchase form with real supplier options and prevents duplicate submission", async () => {
    const user = userEvent.setup();
    mockLoad();
    let resolveCreate!: (v: any) => void;
    const createSpy = vi.spyOn(bridge, "createPurchase").mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<PurchasesPage />);
    await screen.findByText("Acme Dealer");
    await user.click(screen.getByText("Create Purchase"));
    const supplierSelect = screen.getByDisplayValue("Unspecified");
    await user.selectOptions(supplierSelect, "s1");
    await user.type(screen.getByPlaceholderText("Title"), "Lot 1");
    await user.clear(screen.getByPlaceholderText("Unit cost (EUR)"));
    await user.type(screen.getByPlaceholderText("Unit cost (EUR)"), "12.5");
    await user.click(screen.getByText("Submit Purchase"));
    await waitFor(() => expect(screen.getByText("Creating…")).toBeDisabled());
    await user.click(screen.getByText("Creating…"));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({ supplierId: "s1", sourceType: "Other", lines: [{ titleSnapshot: "Lot 1", quantity: 1, unitPurchaseCost: 12.5, productId: undefined }] });
    resolveCreate({ id: "new-purchase-id" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/purchases/new-purchase-id"));
  });

  it("rejects an invalid line client-side without calling the backend", async () => {
    const user = userEvent.setup();
    mockLoad();
    const createSpy = vi.spyOn(bridge, "createPurchase");
    render(<PurchasesPage />);
    await screen.findByText("Acme Dealer");
    await user.click(screen.getByText("Create Purchase"));
    await user.type(screen.getByPlaceholderText("Title"), "Lot 1");
    await user.clear(screen.getByPlaceholderText("Quantity"));
    await user.type(screen.getByPlaceholderText("Quantity"), "0");
    await user.click(screen.getByText("Submit Purchase"));
    await screen.findByText(/positive whole number/);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
