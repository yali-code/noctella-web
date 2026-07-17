import type { InventoryLogger } from "../../services/inventoryApplicationContext";
import type { InventoryEvent } from "../../domain/inventory/events";
import type { InventoryObservability, InventorySignalMeta } from "./types";

export const noopInventoryObservability: InventoryObservability = Object.freeze(
  {},
);

async function safeCall(
  fn: undefined | ((value: any) => void | Promise<void>),
  value: any,
  logger?: InventoryLogger,
) {
  try {
    await fn?.(value);
  } catch (error) {
    try {
      logger?.warn?.("inventory observability failed", {
        error: error instanceof Error ? error.message : "observability failed",
      });
    } catch {
      /* swallow */
    }
  }
}

export async function emitInventorySignal(
  observer: InventoryObservability | undefined,
  method: keyof InventoryObservability,
  value: InventoryEvent | InventorySignalMeta,
  logger?: InventoryLogger,
) {
  await safeCall(observer?.[method] as any, value, logger);
}
