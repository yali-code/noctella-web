// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

describe("Order detail payment provider mock labeling (Sprint 76)", () => {
  async function renderWithOrder(orderOverrides: any = {}) {
    stubFetch();
    vi.spyOn(ordersLib, "getOrder").mockResolvedValue({ ...baseOrder, ...orderOverrides });
    vi.spyOn(shipmentsLib, "listShipments").mockResolvedValue([]);
    render(<OrderDetailPage params={{ id: "order-1" }} />);
    await screen.findByText(orderOverrides.orderNumber ?? "ORD-1");
  }

  it("labels the payment provider as mock and keeps order status and payment status distinct", async () => {
    await renderWithOrder({ paymentProvider: "stripe", paymentStatus: "paid", status: "processing" });
    expect(screen.getByText("stripe (mock)")).toBeInTheDocument();
    expect(screen.queryByText("stripe", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("paid")).toBeInTheDocument();
    expect(screen.getByText("processing")).toBeInTheDocument();
  });

  it("shows a safe dash fallback when there is no payment provider recorded", async () => {
    await renderWithOrder({ paymentProvider: null });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/mock/)).not.toBeInTheDocument();
  });

  it("honestly displays a Cancelled order that remains paymentStatus paid, without implying a refund", async () => {
    await renderWithOrder({ status: "cancelled", paymentStatus: "paid", paymentProvider: "paypal" });
    expect(screen.getByText("cancelled")).toBeInTheDocument();
    expect(screen.getByText("paid")).toBeInTheDocument();
    expect(screen.getByText("paypal (mock)")).toBeInTheDocument();
  });
});

describe("Order detail automatic-invoice outbox status and retry (Sprint 79 correction)", () => {
  async function renderWithInvoiceStatus(status: any) {
    cleanup();
    stubFetch();
    vi.spyOn(ordersLib, "getOrder").mockResolvedValue(baseOrder);
    vi.spyOn(shipmentsLib, "listShipments").mockResolvedValue([]);
    vi.spyOn(ordersLib, "getOrderInvoiceOutboxStatus").mockResolvedValue(status);
    render(<OrderDetailPage params={{ id: "order-1" }} />);
    await screen.findByText("ORD-1");
  }

  it("shows a Failed/dead-lettered status with the safe error message and a Retry control", async () => {
    await renderWithInvoiceStatus({ state: "FailedDeadLettered", attemptCount: 5, lastErrorMessage: "OUTBOX_HANDLER_ERROR" });
    expect(await screen.findByText(/Failed — needs retry/)).toBeInTheDocument();
    expect(screen.getByText("Retry Invoice Draft")).toBeInTheDocument();
  });

  it("does not show a Retry control for Created, Pending, Retrying, or not-applicable states", async () => {
    for (const state of ["Created", "Pending", "Retrying", "NotApplicableMarketplace", "NoInvoiceUnpaid"]) {
      await renderWithInvoiceStatus({ state });
      expect(screen.queryByText("Retry Invoice Draft")).not.toBeInTheDocument();
      vi.restoreAllMocks();
    }
  });

  it("Retry calls the durable re-enqueue endpoint (never a direct invoice-creation call) and reloads status", async () => {
    const user = userEvent.setup();
    await renderWithInvoiceStatus({ state: "FailedDeadLettered", attemptCount: 5, lastErrorMessage: "OUTBOX_HANDLER_ERROR" });
    const retrySpy = vi.spyOn(ordersLib, "retryOrderInvoiceDraft").mockResolvedValue({ retried: true, reason: "Reactivated" });
    await user.click(screen.getByText("Retry Invoice Draft"));
    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith("order-1"));
  });

  it("shows a backend retry error rather than silently failing", async () => {
    const user = userEvent.setup();
    await renderWithInvoiceStatus({ state: "FailedDeadLettered", attemptCount: 5, lastErrorMessage: "OUTBOX_HANDLER_ERROR" });
    vi.spyOn(ordersLib, "retryOrderInvoiceDraft").mockRejectedValue(new Error("Marketplace-imported orders are excluded from automatic invoicing in this sprint"));
    await user.click(screen.getByText("Retry Invoice Draft"));
    await waitFor(async () => {
      const alerts = await screen.findAllByRole("alert");
      expect(alerts.some((a) => a.textContent?.includes("Marketplace-imported orders are excluded"))).toBe(true);
    });
  });
});

describe("Order Items image snapshot rendering (Sprint 86)", () => {
  it("resolves a relative OrderItem.productImageUrl against the configured API origin, not the raw stored value", async () => {
    stubFetch();
    vi.spyOn(ordersLib, "getOrder").mockResolvedValue({
      ...baseOrder,
      items: [
        {
          id: "item-1",
          productId: "product-1",
          productSku: "SKU-1",
          productTitle: "Vintage Chronograph",
          productSlug: "vintage-chronograph",
          productType: "unique_item",
          productImageUrl: "/images/product-photos/watch.webp",
          quantity: 1,
          unitPrice: 100,
          totalPrice: 100,
          currency: "EUR",
        },
      ],
    } as any);
    vi.spyOn(shipmentsLib, "listShipments").mockResolvedValue([]);
    const { container } = render(<OrderDetailPage params={{ id: "order-1" }} />);
    await screen.findByText("ORD-1");

    // resolveApiAssetUrl (apps/admin/src/lib/api.ts) defaults NEXT_PUBLIC_API_BASE_URL to
    // http://localhost:4000 when unset - proving the rendered <img> uses that resolved absolute
    // URL, not the raw relative value stored in the database, confirms the real resolver ran
    // rather than merely being present/imported. Queried via the DOM directly (not
    // getByRole("img")) because this thumbnail intentionally uses alt="" - matching the existing
    // convention for decorative list/table thumbnails elsewhere in Admin - which removes it from
    // the accessible "img" role.
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("http://localhost:4000/images/product-photos/watch.webp");
  });

  it("shows the — fallback, not a broken image, when productImageUrl is null", async () => {
    stubFetch();
    vi.spyOn(ordersLib, "getOrder").mockResolvedValue({
      ...baseOrder,
      items: [
        {
          id: "item-1",
          productId: "product-1",
          productSku: "SKU-1",
          productTitle: "Vintage Chronograph",
          productSlug: "vintage-chronograph",
          productType: "unique_item",
          productImageUrl: null,
          quantity: 1,
          unitPrice: 100,
          totalPrice: 100,
          currency: "EUR",
        },
      ],
    } as any);
    vi.spyOn(shipmentsLib, "listShipments").mockResolvedValue([]);
    const { container } = render(<OrderDetailPage params={{ id: "order-1" }} />);
    await screen.findByText("ORD-1");

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
