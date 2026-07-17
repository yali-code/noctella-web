export const INVENTORY_EVENT_VERSION = 1 as const;

export type InventoryEventName =
  | "inventory.product.created"
  | "inventory.product.updated"
  | "inventory.stock.initialized"
  | "inventory.stock.increased"
  | "inventory.stock.decreased"
  | "inventory.stock.quantity_set"
  | "inventory.stock_location.created";

export type InventoryEventPayload = Readonly<{
  productId?: string;
  stockLocationId?: string;
  sku?: string;
  movementType?: string;
  quantityDelta?: number;
  stockBefore?: number;
  stockAfter?: number;
  idempotencyKey?: string | null;
}>;

export type InventoryEvent = Readonly<{
  id: string;
  name: InventoryEventName;
  version: typeof INVENTORY_EVENT_VERSION;
  occurredAt: string;
  aggregateId: string;
  aggregateType: "inventory" | "product" | "stock_location";
  payload: InventoryEventPayload;
}>;

export function createInventoryEvent(
  input: Omit<InventoryEvent, "version">,
): InventoryEvent {
  return Object.freeze({
    ...input,
    version: INVENTORY_EVENT_VERSION,
    payload: Object.freeze({ ...input.payload }),
  });
}
