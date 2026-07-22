import { OrderStatus } from "@noctella/shared";
import { describe, expect, it } from "vitest";
import {
  canActOnOrderStatus,
  customerName,
  getAvailableOrderStatusActions,
  orderListQuery,
  ORDER_STATUS_ACTIONS,
  type OrderWithItems,
} from "./orders";

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
