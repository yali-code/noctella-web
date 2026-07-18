import { SalesCompletionCapabilityUnavailableError } from "./errors";

export type SalesCompletionCurrency = "EUR";

export interface SalesCompletionReference {
  readonly saleId: string;
  readonly customerId: string | null;
  readonly marketplaceOrderId: string | null;
  readonly shipmentId: string | null;
}

export interface SalesCompletionFulfillmentState {
  readonly paymentAccepted: boolean;
  readonly shippingAccepted: boolean;
  readonly marketplaceRequired: boolean;
  readonly marketplaceAccepted: boolean;
  readonly shipmentId: string | null;
  readonly shippingCost: number;
  readonly currency: SalesCompletionCurrency;
}

export interface SalesCompletionCostRequest {
  readonly saleId: string;
  readonly lines: readonly Readonly<{ productId: string; quantity: number }>[];
}

export interface SalesCompletionProductCost {
  readonly productId: string;
  readonly unitPurchaseCost: number | null;
  readonly currency: SalesCompletionCurrency;
}

export interface SalesCompletionFinancialSnapshot {
  readonly saleId: string;
  readonly grossRevenue: number;
  readonly shippingCharged: number;
  readonly shippingCost: number;
  readonly marketplaceFee: number | null;
  readonly promotedFee: number | null;
  readonly paymentFee: number | null;
  readonly taxVat: number;
  readonly itemCost: number;
  readonly netRevenue: number;
  readonly profit: number;
  readonly currency: SalesCompletionCurrency;
  readonly completedAt: string;
}

export interface SalesCompletionFinanceEntry {
  readonly saleId: string;
  readonly entryType: "CompleteSale";
  readonly amount: number;
  readonly currency: SalesCompletionCurrency;
  readonly sourceReference: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly snapshot: SalesCompletionFinancialSnapshot;
}

export interface SalesCompletionHistoryEntry {
  readonly saleId: string;
  readonly shipmentId: string;
  readonly eventType: "sale_completed";
  readonly occurredAt: string;
  readonly financialSnapshot: SalesCompletionFinancialSnapshot;
}

export interface SalesCompletionCommitInput {
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly financialSnapshotId: string;
  readonly financeEntryId: string;
  readonly completionHistoryId: string | null;
  readonly finalUpdatedAt: string;
  readonly snapshot: SalesCompletionFinancialSnapshot;
  readonly financeEntry: SalesCompletionFinanceEntry;
  readonly historyEntry: SalesCompletionHistoryEntry | null;
}

export interface SalesCompletionCommitResult {
  readonly saleId: string;
  readonly completedAt: string;
  readonly snapshot: SalesCompletionFinancialSnapshot;
  readonly replay: boolean;
}

export interface TransactionalSalesCompletionCoordinator {
  commit(input: SalesCompletionCommitInput): Promise<SalesCompletionCommitResult>;
}

export interface SalesCompletionUnitOfWork {
  run<T>(work: (context: { readonly repositories: { readonly salesCompletion: {
    commit(input: SalesCompletionCommitInput): SalesCompletionCommitResult | Promise<SalesCompletionCommitResult>;
  } } }) => T | Promise<T>): Promise<T>;
}

export function createTransactionalSalesCompletionCoordinator(unitOfWork: SalesCompletionUnitOfWork): TransactionalSalesCompletionCoordinator {
  return Object.freeze({ commit: (input: SalesCompletionCommitInput) => unitOfWork.run(({ repositories }) => repositories.salesCompletion.commit(input)) });
}

export interface SalesCompletionCoordinator {
  inspectFulfillment(reference: SalesCompletionReference): Promise<SalesCompletionFulfillmentState>;
  getProductCosts(request: SalesCompletionCostRequest): Promise<readonly SalesCompletionProductCost[]>;
  findFinancialSnapshot(saleId: string): Promise<SalesCompletionFinancialSnapshot | null>;
  writeFinancialSnapshot(snapshot: SalesCompletionFinancialSnapshot): Promise<void>;
  writeFinanceEntry(entry: SalesCompletionFinanceEntry): Promise<void>;
  recordCompletionHistory(entry: SalesCompletionHistoryEntry): Promise<void>;
}

const unavailable = (capability: string): never => {
  throw new SalesCompletionCapabilityUnavailableError(capability);
};

export const unavailableSalesCompletionCoordinator: SalesCompletionCoordinator = Object.freeze({
  inspectFulfillment: async () => unavailable("fulfillment"),
  getProductCosts: async () => unavailable("product_cost"),
  findFinancialSnapshot: async () => unavailable("financial_snapshot"),
  writeFinancialSnapshot: async () => unavailable("financial_snapshot"),
  writeFinanceEntry: async () => unavailable("finance_entry"),
  recordCompletionHistory: async () => unavailable("completion_history"),
});

