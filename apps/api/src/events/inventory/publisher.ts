import type { InventoryEvent } from "../../domain/inventory/events";

export interface InventoryEventPublisher {
  publish(event: InventoryEvent): void | Promise<void>;
}

export const noopInventoryEventPublisher: InventoryEventPublisher =
  Object.freeze({
    publish: () => undefined,
  });
