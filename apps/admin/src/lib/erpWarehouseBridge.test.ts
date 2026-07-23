import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateWarehouse,
  cancelReservation,
  consumeReservation,
  createLocation,
  createReservation,
  createWarehouse,
  deactivateWarehouse,
  erpWarehouseApi,
  mapAvailability,
  mapLocation,
  mapPacking,
  mapPicking,
  mapReservation,
  mapShipmentReady,
  mapWarehouse,
  mapWarehouseEvent,
  maskCustomer,
  query,
  redactSafeError,
  releaseReservation,
} from "./erpWarehouseBridge";

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

describe("erpWarehouseBridge network behavior (Sprint 58B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no source reference to the plain unauthenticated api client remains, and no path is missing the /api prefix", () => {
    const source = readFileSync(new URL("./erpWarehouseBridge.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{ ApiError \} from ["']\.\/api["']/);
    expect(source).not.toMatch(/\bapi\.get\(/);
    expect(source).not.toMatch(/\bapi\.post\(/);
    expect(source).not.toMatch(/["']\/erp\//);
  });

  it("reads hit the same-origin proxy paths with the /api prefix", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await erpWarehouseApi.warehouses();
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/warehouses");
    await erpWarehouseApi.warehouse("w1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/warehouses/w1");
    await erpWarehouseApi.locations({ warehouseId: "w1" });
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/warehouse/locations?warehouseId=w1");
    await erpWarehouseApi.reservations({ status: "Active" });
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/reservations?status=Active");
    await erpWarehouseApi.events();
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/warehouse/events?");
  });

  it("createWarehouse, activateWarehouse, deactivateWarehouse post to the correct proxy paths with a command envelope", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "Succeeded" }), { status: 200, headers: { "content-type": "application/json" } }));
    await createWarehouse({ code: "MAIN", name: "Main" });
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/erp/commands/warehouses/create");
    const sent = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.payload).toEqual({ code: "MAIN", name: "Main" });
    expect(typeof sent.idempotencyKey).toBe("string");
    await activateWarehouse("w1");
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/erp/commands/warehouses/w1/reactivate");
    await deactivateWarehouse("w1");
    expect(fetchSpy.mock.calls[2][0]).toBe("/api/erp/commands/warehouses/w1/deactivate");
  });

  it("createLocation posts to the correct proxy path", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "Succeeded" }), { status: 201, headers: { "content-type": "application/json" } }));
    await createLocation({ warehouseId: "w1", code: "BIN", name: "Bin" });
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/erp/commands/warehouse-locations/create");
  });

  it("createReservation forwards the exact caller-supplied idempotency key, never generating its own", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "Succeeded", reservationId: "r1" }), { status: 201, headers: { "content-type": "application/json" } }));
    await createReservation({ idempotencyKey: "stable-attempt-key", productId: "p1", quantity: 2, reservationReference: "REF-1", reason: "hold" });
    const [path, init] = fetchSpy.mock.calls[0];
    expect(path).toBe("/api/erp/commands/reservations/create");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.idempotencyKey).toBe("stable-attempt-key");
    expect(sent.payload.productId).toBe("p1");

    // A retry of the same attempt must reuse the identical key.
    await createReservation({ idempotencyKey: "stable-attempt-key", productId: "p1", quantity: 2, reservationReference: "REF-1", reason: "hold" });
    const secondSent = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(secondSent.idempotencyKey).toBe("stable-attempt-key");
  });

  it("releaseReservation, cancelReservation, consumeReservation post to their respective proxy paths", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "Released" }), { status: 200, headers: { "content-type": "application/json" } }));
    await releaseReservation("r1");
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/erp/commands/reservations/r1/release");
    await cancelReservation("r1");
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/erp/commands/reservations/r1/cancel");
    await consumeReservation("r1");
    expect(fetchSpy.mock.calls[2][0]).toBe("/api/erp/commands/reservations/r1/consume");
  });

  it("propagates structured backend errors (status, message) unchanged", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: "Reservation exceeds available quantity" }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(createReservation({ idempotencyKey: "k1", productId: "p1", quantity: 99, reservationReference: "REF", reason: "hold" })).rejects.toMatchObject({ message: "Reservation exceeds available quantity", status: 409 });
  });
});
