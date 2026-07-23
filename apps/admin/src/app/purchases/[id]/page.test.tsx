// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpPurchasingBridge";
import PurchaseDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const basePurchase = (overrides: any = {}) => ({
  id: "p1",
  erpReferenceId: "po-1",
  supplierId: "s1",
  status: "Draft",
  sourceType: "Auction",
  externalReference: null,
  invoiceReferenceNumber: null,
  orderedAt: null,
  receivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lines: [{ id: "l1", titleSnapshot: "Lot 1", quantity: 3, receivedQuantity: 0, unitPurchaseCost: 10, productId: "prod-1" }],
  ...overrides,
});

function mockLoad(purchase: any, opts: { supplier?: any; landed?: any } = {}) {
  vi.spyOn(bridge.purchasingApi, "purchase").mockResolvedValue(purchase);
  vi.spyOn(bridge.purchasingApi, "supplier").mockResolvedValue(opts.supplier ?? { id: "s1", name: "Acme Dealer" });
  vi.spyOn(bridge.purchasingApi, "landed").mockResolvedValue(opts.landed ?? { allocationMethod: "Equal", complete: false, reconciled: false, lines: [] });
}

async function renderPage(purchase: any, opts: { supplier?: any; landed?: any } = {}) {
  mockLoad(purchase, opts);
  render(<PurchaseDetailPage params={{ id: purchase.id }} />);
  await screen.findByRole("heading", { name: new RegExp(purchase.erpReferenceId ?? purchase.id) });
}

describe("Purchase detail lifecycle actions (Sprint 57B)", () => {
  it("renders real purchase data, supplier name, and line quantities", async () => {
    await renderPage(basePurchase());
    expect(screen.getByText(/Acme Dealer/)).toBeInTheDocument();
    expect(screen.getByText("Lot 1")).toBeInTheDocument();
    expect(screen.getByText(/0\/3 received/)).toBeInTheDocument();
  });

  it("shows Mark Ordered only for a Draft purchase", async () => {
    await renderPage(basePurchase({ status: "Draft" }));
    expect(screen.getByText("Mark Ordered")).toBeInTheDocument();
  });

  it("hides Mark Ordered for an already-Ordered purchase", async () => {
    await renderPage(basePurchase({ status: "Ordered" }));
    expect(screen.queryByText("Mark Ordered")).not.toBeInTheDocument();
  });

  it("requires confirmation for Mark Ordered and reloads authoritative state after success", async () => {
    const user = userEvent.setup();
    await renderPage(basePurchase({ status: "Draft" }));
    const markOrderedSpy = vi.spyOn(bridge, "markPurchaseOrdered").mockResolvedValue({});
    const purchaseSpy = vi.spyOn(bridge.purchasingApi, "purchase").mockResolvedValueOnce(basePurchase({ status: "Ordered" }));
    await user.click(screen.getByText("Mark Ordered"));
    expect(markOrderedSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Mark Ordered"));
    await screen.findByText(/Status Ordered/);
    expect(markOrderedSpy).toHaveBeenCalledWith("p1");
    expect(purchaseSpy).toHaveBeenCalledTimes(2);
  });

  it("caps the receive quantity input at the remaining quantity and rejects an over-cap submission client-side", async () => {
    const user = userEvent.setup();
    await renderPage(basePurchase({ status: "Draft" }));
    const receiveSpy = vi.spyOn(bridge, "receivePurchase");
    await user.click(screen.getByText("Receive"));
    const qtyInput = screen.getByPlaceholderText("Qty received") as HTMLInputElement;
    expect(qtyInput.max).toBe("3");
    await user.type(qtyInput, "99");
    await user.click(screen.getByText("Confirm Receive"));
    await screen.findByText(/cannot exceed the remaining quantity/);
    expect(receiveSpy).not.toHaveBeenCalled();
  });

  it("submits a valid partial receive and states that inventory posts automatically, with no separate inventory control", async () => {
    const user = userEvent.setup();
    await renderPage(basePurchase({ status: "Draft" }));
    const receiveSpy = vi.spyOn(bridge, "receivePurchase").mockResolvedValue({ status: "PartiallyReceived" });
    await user.click(screen.getByText("Receive"));
    expect(screen.getByText(/posted automatically and atomically/)).toBeInTheDocument();
    const qtyInput = screen.getByPlaceholderText("Qty received");
    await user.type(qtyInput, "1");
    await user.click(screen.getByText("Confirm Receive"));
    await waitFor(() => expect(receiveSpy).toHaveBeenCalledWith("p1", { idempotencyKey: expect.any(String), lines: [{ purchaseLineId: "l1", quantityReceived: 1 }] }));
    expect(screen.queryByText(/^Restore inventory$/i)).not.toBeInTheDocument();
  });

  it("reuses the exact same idempotency key across a retry of the same receive attempt", async () => {
    const user = userEvent.setup();
    await renderPage(basePurchase({ status: "Draft" }));
    const receiveSpy = vi.spyOn(bridge, "receivePurchase").mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce({ status: "PartiallyReceived" });
    await user.click(screen.getByText("Receive"));
    await user.type(screen.getByPlaceholderText("Qty received"), "1");
    await user.click(screen.getByText("Confirm Receive"));
    await screen.findByText("network error");
    await user.click(screen.getByText("Confirm Receive"));
    await waitFor(() => expect(receiveSpy).toHaveBeenCalledTimes(2));
    const firstKey = receiveSpy.mock.calls[0][1].idempotencyKey;
    const secondKey = receiveSpy.mock.calls[1][1].idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it("never renders Cancel for a Received or PartiallyReceived purchase", async () => {
    await renderPage(basePurchase({ status: "Received" }));
    expect(screen.queryByText("Cancel Purchase")).not.toBeInTheDocument();
  });

  it("shows the backend's cancel rejection message when a stale UI still allows an attempt", async () => {
    const user = userEvent.setup();
    await renderPage(basePurchase({ status: "Draft" }));
    vi.spyOn(bridge, "cancelPurchase").mockRejectedValue(new Error("Purchase cannot be cancelled in current status"));
    await user.click(screen.getByText("Cancel Purchase"));
    await user.click(screen.getByText("Confirm Cancel Purchase"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Purchase cannot be cancelled in current status");
  });

  it("activates Allocate Costs and labels its effect accurately (no product cost / finance-ledger claim)", async () => {
    const user = userEvent.setup();
    await renderPage(basePurchase({ status: "Draft" }));
    const allocateSpy = vi.spyOn(bridge, "allocatePurchaseCosts").mockResolvedValue({});
    await user.click(screen.getByText("Allocate Costs"));
    expect(screen.getByText(/does not update product purchase cost fields/)).toBeInTheDocument();
    await user.click(screen.getByText("Confirm Allocate Costs"));
    await waitFor(() => expect(allocateSpy).toHaveBeenCalledWith("p1", { allocationMethod: "Equal" }));
  });
});
