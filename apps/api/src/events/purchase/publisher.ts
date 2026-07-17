import type { PurchaseEvent } from "../../domain/purchase/events";
export interface PurchaseEventPublisher {
  publish(event: PurchaseEvent): void | Promise<void>;
}
export const noopPurchaseEventPublisher: PurchaseEventPublisher = Object.freeze(
  { publish: () => undefined },
);
