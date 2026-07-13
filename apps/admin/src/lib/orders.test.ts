import { describe, expect, it } from "vitest";
import { customerName, orderListQuery, type OrderWithItems } from "./orders";

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
