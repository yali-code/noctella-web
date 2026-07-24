// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ordersLib from "@/lib/orders";
import * as shipmentsLib from "@/lib/shipments";
import OrderDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const baseOrder: any = {
  id: "order-1",
  orderNumber: "ORD-1",
  status: "processing",
  paymentStatus: "paid",
  paymentProvider: "stripe",
  paymentReference: "pay-1",
  guestEmail: "buyer@example.com",
  notes: null,
  shippingAddress: { fullName: "Jane", line1: "1 Main", city: "Paris", postalCode: "75001", country: "FR" },
  billingAddress: { fullName: "Jane", line1: "1 Main", city: "Paris", postalCode: "75001", country: "FR" },
  subtotalAmount: 100,
  shippingAmount: 0,
  taxAmount: 0,
  totalAmount: 100,
  currency: "EUR",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  items: [],
};

const baseShipment = (overrides: any = {}) => ({
  id: "ship-1",
  orderId: "order-1",
  carrierCode: "ups",
  status: "draft",
  trackingNumber: undefined,
  ...overrides,
});

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null }, json: async () => ({}) } as any)
  );
}

async function renderPage(shipments: any[] = []) {
  stubFetch();
  vi.spyOn(ordersLib, "getOrder").mockResolvedValue(baseOrder);
  vi.spyOn(shipmentsLib, "listShipments").mockResolvedValue(shipments);
  render(<OrderDetailPage params={{ id: "order-1" }} />);
  await screen.findByText("ORD-1");
}

describe("Order detail shipment activation (Sprint 60B)", () => {
  it("loads shipments via the shipment library, scoped to the order", async () => {
    await renderPage([baseShipment()]);
    expect(shipmentsLib.listShipments).toHaveBeenCalledWith({ orderId: "order-1" });
    expect(screen.getByText(/ups \/ draft/)).toBeInTheDocument();
  });

  it("shows the empty state and a Create Shipment control when there is no shipment yet", async () => {
    await renderPage([]);
    expect(screen.getByText(/No shipment yet/)).toBeInTheDocument();
    expect(screen.getByText("Create Shipment")).toBeInTheDocument();
  });

  it("creates a shipment with the entered carrier code and reloads shipments", async () => {
    const user = userEvent.setup();
    await renderPage([]);
    const createSpy = vi.spyOn(shipmentsLib, "createShipment").mockResolvedValue({} as any);
    vi.spyOn(shipmentsLib, "listShipments").mockResolvedValueOnce([]).mockResolvedValueOnce([baseShipment()]);
    await user.click(screen.getByText("Create Shipment"));
    await user.type(screen.getByPlaceholderText("Carrier code (e.g. UPS)"), "UPS");
    await user.click(screen.getByText("Confirm Create Shipment"));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith("order-1", { carrierCode: "UPS", customCarrierName: undefined }));
  });

  it("assigns tracking to the existing shipment", async () => {
    const user = userEvent.setup();
    await renderPage([baseShipment()]);
    const assignSpy = vi.spyOn(shipmentsLib, "assignTracking").mockResolvedValue({} as any);
    await user.click(screen.getByText("Assign Tracking"));
    await user.type(screen.getByPlaceholderText("Tracking number"), "1Z999");
    await user.click(screen.getByText("Confirm Tracking"));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("ship-1", { trackingNumber: "1Z999", trackingUrl: undefined }));
  });

  it("Mark Ready is enabled only for a draft shipment and calls markReady", async () => {
    const user = userEvent.setup();
    await renderPage([baseShipment({ status: "draft" })]);
    const readySpy = vi.spyOn(shipmentsLib, "markReady").mockResolvedValue({} as any);
    const readyButton = screen.getByText("Mark Ready");
    expect(readyButton).toBeEnabled();
    await user.click(readyButton);
    await waitFor(() => expect(readySpy).toHaveBeenCalledWith("ship-1"));
  });

  it("Ship is disabled for a draft shipment and enabled for a ready shipment", async () => {
    await renderPage([baseShipment({ status: "draft" })]);
    expect(screen.getByText("Ship")).toBeDisabled();
  });

  it("Deliver calls deliverShipment for an in_transit shipment and shows the backend error on failure", async () => {
    const user = userEvent.setup();
    await renderPage([baseShipment({ status: "in_transit" })]);
    vi.spyOn(shipmentsLib, "deliverShipment").mockRejectedValue(new Error("Shipment is terminal"));
    await user.click(screen.getByText("Deliver"));
    await waitFor(async () => {
      const alerts = await screen.findAllByRole("alert");
      expect(alerts.some((a) => a.textContent?.includes("Shipment is terminal"))).toBe(true);
    });
  });
});
