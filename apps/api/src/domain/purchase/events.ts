export const PURCHASE_EVENT_VERSION = 1 as const;

export type PurchaseEventName =
  | "purchase.created"
  | "purchase.updated"
  | "purchase.ordered"
  | "purchase.cancelled"
  | "purchase.received"
  | "purchase.partially_received"
  | "supplier.created"
  | "supplier.updated";

export type PurchaseEventPayload = Readonly<{
  purchaseId?: string;
  supplierId?: string | null;
  receiptId?: string;
  idempotencyKey?: string | null;
  status?: string;
  sourceType?: string;
  lineCount?: number;
  totalCost?: number | null;
  erpReferenceId?: string | null;
  name?: string;
}>;

export type PurchaseEvent = Readonly<{
  id: string;
  name: PurchaseEventName;
  version: typeof PURCHASE_EVENT_VERSION;
  occurredAt: string;
  aggregateId: string;
  aggregateType: "purchase" | "supplier";
  payload: PurchaseEventPayload;
}>;

export function createPurchaseEvent(
  input: Omit<PurchaseEvent, "version">,
): PurchaseEvent {
  return Object.freeze({
    ...input,
    version: PURCHASE_EVENT_VERSION,
    payload: Object.freeze({ ...input.payload }),
  });
}
