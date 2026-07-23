// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import WarehouseDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const activeWarehouse = { id: "w1", code: "MAIN", name: "Main Warehouse", status: "Active", country_code: "BE", city: "Brussels", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };

async function renderPage(warehouse: any) {
  vi.spyOn(bridge.erpWarehouseApi, "warehouse").mockResolvedValue(warehouse);
  render(<WarehouseDetailPage params={{ id: warehouse.id }} />);
  await screen.findByRole("heading", { name: warehouse.name });
}

describe("Warehouse detail lifecycle actions (Sprint 58B)", () => {
  it("renders real warehouse data", async () => {
    await renderPage(activeWarehouse);
    expect(screen.getByText(/Code MAIN/)).toBeInTheDocument();
  });

  it("shows Deactivate (not Activate) for an Active warehouse", async () => {
    await renderPage(activeWarehouse);
    expect(screen.getByText("Deactivate")).toBeInTheDocument();
    expect(screen.queryByText("Activate")).not.toBeInTheDocument();
  });

  it("shows Activate (not Deactivate) for an Inactive warehouse", async () => {
    await renderPage({ ...activeWarehouse, status: "Inactive" });
    expect(screen.getByText("Activate")).toBeInTheDocument();
    expect(screen.queryByText("Deactivate")).not.toBeInTheDocument();
  });

  it("requires confirmation for Deactivate and reloads authoritative state after success", async () => {
    const user = userEvent.setup();
    await renderPage(activeWarehouse);
    const deactivateSpy = vi.spyOn(bridge, "deactivateWarehouse").mockResolvedValue({});
    vi.spyOn(bridge.erpWarehouseApi, "warehouse").mockResolvedValueOnce({ ...activeWarehouse, status: "Inactive" });
    await user.click(screen.getByText("Deactivate"));
    expect(deactivateSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Deactivate"));
    await screen.findByText("Activate");
    expect(deactivateSpy).toHaveBeenCalledWith("w1");
  });

  it("shows the backend's rejection message on failure", async () => {
    const user = userEvent.setup();
    await renderPage(activeWarehouse);
    vi.spyOn(bridge, "deactivateWarehouse").mockRejectedValue(new Error("Warehouse not found"));
    await user.click(screen.getByText("Deactivate"));
    await user.click(screen.getByText("Confirm Deactivate"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Warehouse not found");
  });
});
