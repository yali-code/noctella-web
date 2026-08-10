// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as bridge from "@/lib/erpWarehouseBridge";
import * as shipments from "@/lib/shipments";
import ShipmentReadyPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Shipment Ready queue page", () => {
  it("creates a shipment from a ReadyForShipment row with its packing task", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "shipmentReady").mockResolvedValue({
      items: [{ orderId: "o1", orderNumber: "ORD-1", packingTaskId: "pack-1", packingStatus: "ReadyForShipment", packageCount: 2, totalWeight: 3.5, readinessIssues: [] }],
    });
    const create = vi.spyOn(shipments, "createShipment").mockResolvedValue({ id: "shipment-1" } as any);
    render(<ShipmentReadyPage />);
    await screen.findByText("ORD-1");
    expect(screen.getByText("ReadyForShipment")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Carrier for ORD-1"), { target: { value: "ups" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Shipment" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("o1", { packingTaskId: "pack-1", carrierCode: "ups" }));
  });

  it("keeps a failed row visible and permits a successful retry", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "shipmentReady").mockResolvedValue({
      items: [{ orderId: "o1", orderNumber: "ORD-1", packingTaskId: "pack-1", packingStatus: "ReadyForShipment", packageCount: 1, readinessIssues: [] }],
    });
    const create = vi.spyOn(shipments, "createShipment").mockRejectedValueOnce(new Error("Shipment creation failed")).mockResolvedValueOnce({ id: "shipment-1" } as any);
    render(<ShipmentReadyPage />);
    await screen.findByText("ORD-1");
    fireEvent.change(screen.getByLabelText("Carrier for ORD-1"), { target: { value: "ups" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Shipment" }));
    await screen.findByText("Shipment creation failed");
    expect(screen.getByText("ORD-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Shipment" }));
    await waitFor(() => expect(screen.queryByText("ORD-1")).not.toBeInTheDocument());
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "shipmentReady").mockResolvedValue({ items: [] });
    render(<ShipmentReadyPage />);
    await screen.findByText("No orders are ready for shipment.");
  });

  it("renders an error state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "shipmentReady").mockRejectedValue(new Error("ERP authentication failed"));
    render(<ShipmentReadyPage />);
    await screen.findByText("ERP authentication failed");
  });
});
