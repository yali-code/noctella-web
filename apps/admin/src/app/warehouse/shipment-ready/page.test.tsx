// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpWarehouseBridge";
import ShipmentReadyPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Shipment Ready queue page (Sprint 59B, read-only)", () => {
  it("renders real rows and no mutation actions", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "shipmentReady").mockResolvedValue({
      items: [{ orderId: "o1", orderNumber: "ORD-1", packingStatus: "ReadyForShipment", packageCount: 2, totalWeight: 3.5, readinessIssues: [] }],
    });
    render(<ShipmentReadyPage />);
    await screen.findByText("ORD-1");
    expect(screen.getByText("ReadyForShipment")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
