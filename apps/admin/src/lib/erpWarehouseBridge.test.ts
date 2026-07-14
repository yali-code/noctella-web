import { describe, expect, it } from "vitest";
import { mapAvailability, mapLocation, mapPacking, mapPicking, mapReservation, mapShipmentReady, mapWarehouse, mapWarehouseEvent, maskCustomer, query, redactSafeError } from "./erpWarehouseBridge";

describe("erpWarehouseBridge admin mappers", () => {
  it("maps warehouse, location, availability and history safely", () => {
    expect(mapWarehouse({ id:"w1", code:"MAIN", name:"Main", status:"Active" }).href).toBe("/warehouses/w1");
    expect(mapLocation({ id:"l1", warehouse_id:"w1", location_type:"Bin", code:"A", name:"A", status:"Active" }).type).toBe("Bin");
    expect(mapAvailability({ productId:"p1", physicalQuantity:5, reservedQuantity:2, availableQuantity:3 }).availableQuantity).toBe(3);
    expect(mapWarehouseEvent({ id:"e1", event_type:"ReservationCreated", product_id:"p1" }).type).toBe("ReservationCreated");
  });

  it("maps reservation, picking, packing and shipment-ready eligibility", () => {
    expect(mapReservation({ id:"r1", quantity:1, status:"Active" }).canRelease).toBe(true);
    expect(mapPicking({ id:"pick1", status:"Pending" }).canStart).toBe(true);
    expect(mapPacking({ id:"pack1", status:"Packed", package_count:2 }).canReady).toBe(true);
    expect(mapShipmentReady({ orderId:"o1", orderNumber:"N1", customerMaskedSummary:"person@example.com" }).customerMaskedSummary).toBe("pe***");
  });

  it("builds filters and redacts secrets", () => {
    expect(query("/erp/reservations", { status:"Active", empty:"" })).toBe("/erp/reservations?status=Active");
    expect(maskCustomer("ab@example.com")).toBe("ab***");
    expect(redactSafeError("token=secret api_key=raw")).toContain("***");
  });
});
