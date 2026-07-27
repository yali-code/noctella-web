// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ordersLib from "@/lib/orders";
import OrdersPage from "./page";

afterEach(() => vi.restoreAllMocks());

function baseOrder(overrides: any = {}): any {
  return {
    id: "order-1",
    orderNumber: "NOC-20260101-000001",
    status: "pending",
    paymentStatus: "paid",
    paymentProvider: "stripe",
    guestEmail: "buyer@example.com",
    shippingAddress: { fullName: "Jane Collector" },
    billingAddress: { fullName: "Jane Collector" },
    totalAmount: 100,
    currency: "EUR",
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    items: [],
    ...overrides,
  };
}

function response(data: any[], overrides: any = {}) {
  return {
    data,
    pagination: { page: 1, pageSize: 20, total: data.length, totalPages: 1, ...overrides },
  };
}

describe("Admin orders list page", () => {
  it("loads orders through the real orders client module and renders them", async () => {
    vi.spyOn(ordersLib, "listOrders").mockResolvedValue(response([baseOrder()]));
    render(<OrdersPage />);

    const orderLink = await screen.findByText("NOC-20260101-000001");
    const row = orderLink.closest("tr") as HTMLElement;
    expect(within(row).getByText("Jane Collector")).toBeInTheDocument();
    expect(within(row).getByText("buyer@example.com")).toBeInTheDocument();
    expect(within(row).getByText("pending")).toBeInTheDocument();
    expect(within(row).getByText("paid")).toBeInTheDocument();
    expect(within(row).getByText("100.00")).toBeInTheDocument();
  });

  it("shows a loading state before orders resolve", async () => {
    let resolve: (v: any) => void = () => {};
    vi.spyOn(ordersLib, "listOrders").mockReturnValue(new Promise((r) => (resolve = r)));
    render(<OrdersPage />);
    expect(screen.getByText("Loading orders...")).toBeInTheDocument();
    resolve(response([]));
    await waitFor(() => expect(screen.queryByText("Loading orders...")).not.toBeInTheDocument());
  });

  it("shows an empty state when there are no orders", async () => {
    vi.spyOn(ordersLib, "listOrders").mockResolvedValue(response([]));
    render(<OrdersPage />);
    await screen.findByText("No orders found.");
  });

  it("shows the backend error message when the orders request fails", async () => {
    vi.spyOn(ordersLib, "listOrders").mockRejectedValue(new Error("Failed to reach the orders API"));
    render(<OrdersPage />);
    await screen.findByText("Failed to reach the orders API");
  });

  it("Previous is disabled on page 1 and Next requests the next page", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(ordersLib, "listOrders")
      .mockResolvedValueOnce(response([baseOrder()], { page: 1, total: 2, totalPages: 2 }))
      .mockResolvedValueOnce(response([baseOrder({ id: "order-2", orderNumber: "NOC-20260101-000002" })], {
        page: 2,
        total: 2,
        totalPages: 2,
      }));
    render(<OrdersPage />);

    await screen.findByText("NOC-20260101-000001");
    expect(screen.getByText("Previous")).toBeDisabled();
    expect(screen.getByText("Next")).toBeEnabled();

    await user.click(screen.getByText("Next"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    await screen.findByText("NOC-20260101-000002");
  });
});
