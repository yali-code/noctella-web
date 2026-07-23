import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateWarehouse,
  cancelPackingTask,
  cancelPickingTask,
  cancelReservation,
  completePackingTask,
  completePickingTask,
  confirmPickedLine,
  consumeReservation,
  createLocation,
  createPackingTask,
  createPickingTask,
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
  markPackingReady,
  markPickingShort,
  maskCustomer,
  query,
  redactSafeError,
  releaseReservation,
  startPackingTask,
  startPickingTask,
  updatePackingTask,
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

describe("erpWarehouseBridge picking/packing/shipment-ready network behavior (Sprint 59B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads hit the correct same-origin proxy paths", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await erpWarehouseApi.picking();
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/picking?");
    await erpWarehouseApi.pickingTask("t1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/picking/t1");
    await erpWarehouseApi.packing();
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/packing?");
    await erpWarehouseApi.packingTask("t1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/packing/t1");
    await erpWarehouseApi.shipmentReady();
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/warehouse/shipment-ready");
  });

  it("every picking mutation forwards the caller-supplied idempotency key to the correct path, never generating its own", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "Succeeded" }), { status: 200, headers: { "content-type": "application/json" } }));
    await createPickingTask("o1", "k-create", { safeNotes: "note" });
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/erp/commands/orders/o1/picking/create");
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).idempotencyKey).toBe("k-create");
    await startPickingTask("t1", "k-start");
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/erp/commands/picking/t1/start");
    expect(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string).idempotencyKey).toBe("k-start");
    await confirmPickedLine("t1", "l1", "k-confirm", 2);
    expect(fetchSpy.mock.calls[2][0]).toBe("/api/erp/commands/picking/t1/lines/l1/confirm");
    const confirmSent = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string);
    expect(confirmSent.idempotencyKey).toBe("k-confirm");
    expect(confirmSent.payload).toEqual({ pickedQuantity: 2 });
    await markPickingShort("t1", "l1", "k-short", 1);
    expect(fetchSpy.mock.calls[3][0]).toBe("/api/erp/commands/picking/t1/lines/l1/short");
    expect(JSON.parse((fetchSpy.mock.calls[3][1] as RequestInit).body as string).payload).toEqual({ shortQuantity: 1 });
    await completePickingTask("t1", "k-complete");
    expect(fetchSpy.mock.calls[4][0]).toBe("/api/erp/commands/picking/t1/complete");
    await cancelPickingTask("t1", "k-cancel");
    expect(fetchSpy.mock.calls[5][0]).toBe("/api/erp/commands/picking/t1/cancel");
  });

  it("every packing mutation forwards the caller-supplied idempotency key to the correct path, never generating its own", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "Succeeded" }), { status: 200, headers: { "content-type": "application/json" } }));
    await createPackingTask("o1", "k-create", { pickingTaskId: "t1" });
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/erp/commands/orders/o1/packing/create");
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).idempotencyKey).toBe("k-create");
    await startPackingTask("p1", "k-start");
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/erp/commands/packing/p1/start");
    await updatePackingTask("p1", "k-update", { packageCount: 2, totalWeight: 3.5 });
    expect(fetchSpy.mock.calls[2][0]).toBe("/api/erp/commands/packing/p1/update");
    expect(JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string).payload).toEqual({ packageCount: 2, totalWeight: 3.5 });
    await completePackingTask("p1", "k-complete");
    expect(fetchSpy.mock.calls[3][0]).toBe("/api/erp/commands/packing/p1/complete");
    await markPackingReady("p1", "k-ready");
    expect(fetchSpy.mock.calls[4][0]).toBe("/api/erp/commands/packing/p1/ready-for-shipment");
    await cancelPackingTask("p1", "k-cancel");
    expect(fetchSpy.mock.calls[5][0]).toBe("/api/erp/commands/packing/p1/cancel");
  });

  it("propagates a structured duplicate-task conflict unchanged", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: "An active picking task already exists for this order" }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(createPickingTask("o1", "k1")).rejects.toMatchObject({ message: "An active picking task already exists for this order", status: 409 });
  });
});
