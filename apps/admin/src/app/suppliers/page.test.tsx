// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpPurchasingBridge";
import SuppliersPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const supplierRow = { id: "s1", name: "Acme Dealer", status: "Active", supplierType: "Dealer", countryCode: "BE", city: "Brussels", erpReferenceId: "erp-1", purchaseCount: 3, lastPurchaseAt: "2026-01-01" };

describe("Suppliers list page (Sprint 57B)", () => {
  it("renders real supplier rows", async () => {
    vi.spyOn(bridge.purchasingApi, "suppliers").mockResolvedValue({ items: [supplierRow] });
    render(<SuppliersPage />);
    await screen.findByText("Acme Dealer");
    expect(screen.getByText("erp-1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.purchasingApi, "suppliers").mockResolvedValue({ items: [] });
    render(<SuppliersPage />);
    await screen.findByText("No suppliers found.");
  });

  it("renders an error state", async () => {
    vi.spyOn(bridge.purchasingApi, "suppliers").mockRejectedValue(new Error("ERP authentication failed"));
    render(<SuppliersPage />);
    await screen.findByText("ERP authentication failed");
  });

  it("creates a supplier and navigates to it, preventing duplicate submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge.purchasingApi, "suppliers").mockResolvedValue({ items: [] });
    let resolveCreate!: (v: any) => void;
    const createSpy = vi.spyOn(bridge, "createSupplier").mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<SuppliersPage />);
    await screen.findByText("No suppliers found.");
    await user.click(screen.getByText("Create Supplier"));
    await user.type(screen.getByPlaceholderText("Name"), "New Supplier");
    await user.click(screen.getByText("Submit Supplier"));
    await waitFor(() => expect(screen.getByText("Creating…")).toBeDisabled());
    await user.click(screen.getByText("Creating…"));
    expect(createSpy).toHaveBeenCalledTimes(1);
    resolveCreate({ id: "new-supplier-id" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/suppliers/new-supplier-id"));
  });
});
