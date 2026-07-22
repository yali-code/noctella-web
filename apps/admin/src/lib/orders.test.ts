import { OrderStatus } from "@noctella/shared";
import { describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  canActOnOrderStatus,
  completeSale,
  customerName,
  getAvailableOrderStatusActions,
  orderListQuery,
  ORDER_STATUS_ACTIONS,
  type OrderWithItems,
} from "./orders";
vi.mock("./api", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
const mockedApi = vi.mocked(api);

const order = {
  shippingAddress: { fullName: "Jane Collector" },
  billingAddress: { fullName: "Billing Name" },
} as OrderWithItems;

describe("admin order list helpers", () => {
  it("maps customer name from the shipping address", () => {
    expect(customerName(order)).toBe("Jane Collector");
  });

  it("builds search, filter, and pagination query params", () => {
    expect(
      orderListQuery({ page: 2, pageSize: 20, search: "NOC", status: "confirmed", paymentStatus: "paid" }),
    ).toBe("page=2&pageSize=20&search=NOC&status=confirmed&paymentStatus=paid");
  });

  it("posts to the existing complete-sale endpoint via the shared API client", async () => {
    mockedApi.post.mockResolvedValueOnce({ status: "blocked", issues: ["Order is unpaid"] });
    const result = await completeSale("order-1");
    expect(mockedApi.post).toHaveBeenCalledWith("/api/orders/order-1/complete-sale", {});
    expect(result).toEqual({ status: "blocked", issues: ["Order is unpaid"] });
  });
});

describe("admin order status actions", () => {
  it("Draft: allows confirm and cancel, not begin-processing", () => {
    expect(canActOnOrderStatus("draft", "confirm")).toBe(true);
    expect(canActOnOrderStatus("draft", "cancel")).toBe(true);
    expect(canActOnOrderStatus("draft", "begin-processing")).toBe(false);
  });

  it("Pending: allows confirm, begin-processing, and cancel", () => {
    expect(canActOnOrderStatus("pending", "confirm")).toBe(true);
    expect(canActOnOrderStatus("pending", "begin-processing")).toBe(true);
    expect(canActOnOrderStatus("pending", "cancel")).toBe(true);
  });

  it("Confirmed: allows begin-processing and cancel, not confirm", () => {
    expect(canActOnOrderStatus("confirmed", "begin-processing")).toBe(true);
    expect(canActOnOrderStatus("confirmed", "cancel")).toBe(true);
    expect(canActOnOrderStatus("confirmed", "confirm")).toBe(false);
  });

  it("Processing: allows only cancel", () => {
    expect(canActOnOrderStatus("processing", "cancel")).toBe(true);
    expect(canActOnOrderStatus("processing", "confirm")).toBe(false);
    expect(canActOnOrderStatus("processing", "begin-processing")).toBe(false);
  });

  it("Shipped: no visible actions", () => {
    expect(getAvailableOrderStatusActions("shipped")).toEqual([]);
  });

  it("Completed: no visible actions", () => {
    expect(getAvailableOrderStatusActions("completed")).toEqual([]);
  });

  it("Cancelled: no visible actions", () => {
    expect(getAvailableOrderStatusActions("cancelled")).toEqual([]);
  });

  it("no action ever targets Shipped, Completed, or Pending", () => {
    const targets = ORDER_STATUS_ACTIONS.map((a) => a.target);
    expect(targets).not.toContain(OrderStatus.Shipped);
    expect(targets).not.toContain(OrderStatus.Completed);
    expect(targets).not.toContain(OrderStatus.Pending);
  });
});
