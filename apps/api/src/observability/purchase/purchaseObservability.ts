import type { PurchaseLogger } from "../../services/purchaseApplicationContext";
import type { PurchaseEvent } from "../../domain/purchase/events";
import type { PurchaseObservability, PurchaseSignalMeta } from "./types";
export const noopPurchaseObservability: PurchaseObservability = Object.freeze(
  {},
);
async function safeCall(
  fn: undefined | ((value: any) => void | Promise<void>),
  value: any,
  logger?: PurchaseLogger,
) {
  try {
    await fn?.(value);
  } catch (error) {
    try {
      logger?.warn?.("purchase observability failed", {
        error: error instanceof Error ? error.message : "observability failed",
      });
    } catch {
      /* swallow */
    }
  }
}
export async function emitPurchaseSignal(
  observer: PurchaseObservability | undefined,
  method: keyof PurchaseObservability,
  value: PurchaseEvent | PurchaseSignalMeta,
  logger?: PurchaseLogger,
) {
  await safeCall(observer?.[method] as any, value, logger);
}
