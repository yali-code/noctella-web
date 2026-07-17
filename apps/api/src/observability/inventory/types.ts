import type { InventoryEvent } from "../../domain/inventory/events";

export type InventorySignalMeta = Readonly<{
  eventId?: string;
  eventName?: string;
  aggregateId?: string;
  idempotencyKey?: string | null;
  error?: string;
}>;

export interface InventoryObservability {
  inventoryEventPublished?(event: InventoryEvent): void | Promise<void>;
  inventoryEventPublicationFailed?(
    meta: InventorySignalMeta,
  ): void | Promise<void>;
  inventoryIdempotentReplayDetected?(
    meta: InventorySignalMeta,
  ): void | Promise<void>;
}
