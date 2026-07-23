// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import WarehousesPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const warehouseRow = { id: "w1", code: "MAIN", name: "Main Warehouse", status: "Active" };

describe("Warehouses list page (Sprint 58B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "warehouses").mockResolvedValue({ items: [warehouseRow] });
    render(<WarehousesPage />);
    await screen.findByText("Main Warehouse");
    expect(screen.getByText("MAIN")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "warehouses").mockResolvedValue({ items: [] });
    render(<WarehousesPage />);
    await screen.findByText("No warehouses found.");
  });

  it("renders an error state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "warehouses").mockRejectedValue(new Error("ERP authentication failed"));
    render(<WarehousesPage />);
    await screen.findByText("ERP authentication failed");
  });

  it("creates a warehouse and navigates to it, preventing duplicate submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge.erpWarehouseApi, "warehouses").mockResolvedValue({ items: [] });
    let resolveCreate!: (v: any) => void;
    const createSpy = vi.spyOn(bridge, "createWarehouse").mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<WarehousesPage />);
    await screen.findByText("No warehouses found.");
    await user.click(screen.getByText("Create Warehouse"));
    await user.type(screen.getByPlaceholderText("Code"), "MAIN");
    await user.type(screen.getByPlaceholderText("Name"), "Main Warehouse");
    await user.click(screen.getByText("Submit Warehouse"));
    await waitFor(() => expect(screen.getByText("Creating…")).toBeDisabled());
    await user.click(screen.getByText("Creating…"));
    expect(createSpy).toHaveBeenCalledTimes(1);
    resolveCreate({ warehouseId: "new-warehouse-id" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/warehouses/new-warehouse-id"));
  });
});
