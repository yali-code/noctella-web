import { describe, expect, it } from "vitest";
import { mapAnalytics, mapCustomer, mapTimelineItem, maskCustomerValue, redactCustomerError } from "./erpCustomerBridge";
describe("erp customer bridge admin mappings", () => {
  it("maps customers, timeline, analytics and redacts sensitive errors", () => {
    expect(mapCustomer({ id:"c1", name:"Ada", email:"a***@x.test", erpReferenceId:"erp" }).href).toBe("/customers/c1");
    expect(mapTimelineItem({ type:"Order", entityId:"o1", occurredAt:"now" }).readOnly).toBe(true);
    expect(mapAnalytics({ lifetimeValue:12, averageOrderValue:null }).lifetimeValue).toBe("€12.00");
    expect(maskCustomerValue("abcdef")).toBe("a***f");
    expect(redactCustomerError("token=abc tax=123")).not.toContain("abc");
  });
});
