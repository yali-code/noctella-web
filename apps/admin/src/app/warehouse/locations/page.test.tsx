// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import WarehouseLocationsPage from "./page";

afterEach(() => vi.restoreAllMocks());

const warehouseRow = { id: "w1", code: "MAIN", name: "Main Warehouse", status: "Active" };
const locationRow = { id: "l1", warehouse_id: "w1", code: "BIN-A", name: "Bin A", location_type: "Bin", status: "Active" };

function mockLoad(overrides: { locations?: any[]; warehouses?: any[] } = {}) {
  vi.spyOn(bridge.erpWarehouseApi, "locations").mockResolvedValue({ items: overrides.locations ?? [locationRow] });
  vi.spyOn(bridge.erpWarehouseApi, "warehouses").mockResolvedValue({ items: overrides.warehouses ?? [warehouseRow] });
}

describe("Warehouse locations page (Sprint 58B)", () => {
  it("renders real location rows with the warehouse code resolved", async () => {
    mockLoad();
    render(<WarehouseLocationsPage />);
    await screen.findByText("BIN-A");
    expect(screen.getByText("Bin A")).toBeInTheDocument();
    expect(screen.getByText("MAIN")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    mockLoad({ locations: [] });
    render(<WarehouseLocationsPage />);
    await screen.findByText("No locations found.");
  });

  it("renders an error state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "locations").mockRejectedValue(new Error("ERP authentication failed"));
    vi.spyOn(bridge.erpWarehouseApi, "warehouses").mockResolvedValue({ items: [] });
    render(<WarehouseLocationsPage />);
    await screen.findByText("ERP authentication failed");
  });

  it("creates a location with a real warehouse selection and shows success", async () => {
    const user = userEvent.setup();
    mockLoad();
    const createSpy = vi.spyOn(bridge, "createLocation").mockResolvedValue({ locationId: "l2" });
    render(<WarehouseLocationsPage />);
    await screen.findByText("BIN-A");
    await user.click(screen.getByText("Create Location"));
    expect(screen.getByText("MAIN — Main Warehouse")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Code"), "BIN-B");
    await user.type(screen.getByPlaceholderText("Name"), "Bin B");
    await user.click(screen.getByText("Submit Location"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ warehouseId: "w1", code: "BIN-B", name: "Bin B" })));
    await screen.findByText("Location created.");
  });
});
