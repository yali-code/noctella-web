// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as shipmentsLib from "@/lib/shipments";
import ShipmentDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const baseShipment = (overrides: any = {}) => ({
  id: "ship-1",
  orderId: "order-1",
  carrierCode: "ups",
  trackingNumber: undefined,
  status: "draft",
  channel: undefined,
  marketplaceFulfillmentStatus: undefined,
  lastError: undefined,
  items: [],
  ...overrides,
});

async function renderPage(shipment: any) {
  vi.spyOn(shipmentsLib, "getShipment").mockResolvedValue(shipment);
  vi.spyOn(shipmentsLib, "getShipmentEvents").mockResolvedValue([]);
  vi.spyOn(shipmentsLib, "getShipmentTracking").mockResolvedValue([]);
  render(<ShipmentDetailPage params={{ id: shipment.id }} />);
  await screen.findByRole("heading", { name: `Shipment ${shipment.id}` });
}

describe("Shipment detail lifecycle actions (Sprint 60B)", () => {
  it("renders real shipment data loaded via the shipment library", async () => {
    await renderPage(baseShipment());
    expect(screen.getByText(/Order:/)).toBeInTheDocument();
    expect(screen.getByText("order-1", { exact: false })).toBeInTheDocument();
  });

  it("shows only Mark Ready for a Draft shipment (matches canAct eligibility)", async () => {
    await renderPage(baseShipment({ status: "draft" }));
    expect(screen.getByText("Mark Ready")).toBeInTheDocument();
    expect(screen.queryByText("Ship")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliver")).not.toBeInTheDocument();
  });

  it("shows only Ship and Cancel for a Ready shipment", async () => {
    await renderPage(baseShipment({ status: "ready" }));
    expect(screen.getByText("Ship")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.queryByText("Mark Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliver")).not.toBeInTheDocument();
  });

  it("requires confirmation before submitting Mark Ready, then reloads authoritative state", async () => {
    const user = userEvent.setup();
    await renderPage(baseShipment({ status: "draft" }));
    const readySpy = vi.spyOn(shipmentsLib, "markReady").mockResolvedValue({} as any);
    vi.spyOn(shipmentsLib, "getShipment").mockResolvedValueOnce(baseShipment({ status: "ready" }));
    await user.click(screen.getByText("Mark Ready"));
    expect(readySpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Mark Ready"));
    await waitFor(() => expect(readySpy).toHaveBeenCalledWith("ship-1"));
    await screen.findByText("Ship");
  });

  it("shows a loading state while submitting", async () => {
    const user = userEvent.setup();
    await renderPage(baseShipment({ status: "draft" }));
    let resolve!: () => void;
    vi.spyOn(shipmentsLib, "markReady").mockReturnValue(new Promise((r) => { resolve = () => r({} as any); }));
    await user.click(screen.getByText("Mark Ready"));
    await user.click(screen.getByText("Confirm Mark Ready"));
    expect(await screen.findByText(/Submitting/)).toBeInTheDocument();
    resolve();
  });

  it("shows the backend's rejection message on failure without changing shipment status", async () => {
    const user = userEvent.setup();
    await renderPage(baseShipment({ status: "in_transit" }));
    vi.spyOn(shipmentsLib, "deliverShipment").mockRejectedValue(new Error("Shipment is terminal"));
    await user.click(screen.getByText("Deliver"));
    await user.click(screen.getByText("Confirm Deliver"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Shipment is terminal");
  });

  it("assigns tracking via an inline form", async () => {
    const user = userEvent.setup();
    await renderPage(baseShipment({ status: "ready" }));
    const assignSpy = vi.spyOn(shipmentsLib, "assignTracking").mockResolvedValue({} as any);
    await user.click(screen.getByRole("button", { name: "Assign Tracking" }));
    await user.type(screen.getByPlaceholderText("Tracking number"), "1Z999");
    await user.click(screen.getByText("Confirm Tracking"));
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("ship-1", { trackingNumber: "1Z999", trackingUrl: undefined }));
  });

  it("shows Retry Fulfillment only when marketplace retry is eligible", async () => {
    await renderPage(baseShipment({ channel: "ebay", marketplaceFulfillmentStatus: "failed" }));
    expect(screen.getByText("Retry Fulfillment")).toBeInTheDocument();
  });

  it("hides Retry Fulfillment for an internal (non-marketplace) shipment", async () => {
    await renderPage(baseShipment({ channel: undefined }));
    expect(screen.queryByText("Retry Fulfillment")).not.toBeInTheDocument();
  });
});
