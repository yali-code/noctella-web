import type { PurchaseEvent } from "../../domain/purchase/events";
export type PurchaseSignalMeta = Readonly<{
  eventId?: string;
  eventName?: string;
  aggregateId?: string;
  idempotencyKey?: string | null;
  error?: string;
}>;
export interface PurchaseObservability {
  purchaseEventPublished?(event: PurchaseEvent): void | Promise<void>;
  purchaseEventPublicationFailed?(
    meta: PurchaseSignalMeta,
  ): void | Promise<void>;
  purchaseIdempotentReplayDetected?(
    meta: PurchaseSignalMeta,
  ): void | Promise<void>;
}
