import type { SalesApplicationContext } from "../../services/salesApplicationContext";
import { createTransactionalSalesCompletionCoordinator } from "./completionCoordination";
import { InvalidSaleStatusTransitionError, SaleAlreadyCompletedConflictError, SaleConcurrencyConflictError, SaleNotFoundError, SalesCompletionCoordinationError, SalesCompletionIdempotencyConflictError, SalesCompletionReadinessError, SalesUseCaseError, SalesValidationError } from "./errors";
import type { CompleteSaleInput, CompleteSaleResult } from "./completeSaleTypes";

const required = (value: string, label: string) => { if (!value.trim()) throw new SalesValidationError(`${label} is required`); };

export class CompleteSaleUseCase {
  constructor(private readonly ctx: SalesApplicationContext) {}

  async execute(input: CompleteSaleInput): Promise<CompleteSaleResult> {
    required(input.snapshot.saleId, "Sale ID");
    required(input.expectedVersion, "Expected version");
    required(input.idempotencyKey, "Idempotency key");
    required(input.payloadFingerprint, "Payload fingerprint");
    required(input.financialSnapshotId, "Financial snapshot ID");
    required(input.financeEntryId, "Finance entry ID");
    if (input.snapshot.saleId !== input.financeEntry.saleId || input.snapshot.saleId !== input.financeEntry.snapshot.saleId || input.historyEntry?.saleId !== input.snapshot.saleId) throw new SalesValidationError("Completion sale IDs must match");
    const sale = await this.ctx.saleRepository.findById(input.snapshot.saleId);
    if (!sale) throw new SaleNotFoundError();
    if (sale.status !== "Delivered" && sale.status !== "Completed") throw new InvalidSaleStatusTransitionError();
    if (sale.status !== "Completed" && (sale.paymentStatus !== "Paid" || sale.payment.status !== "Paid")) throw new SalesCompletionReadinessError();
    try {
      const completed = await createTransactionalSalesCompletionCoordinator(this.ctx.unitOfWork).commit(input);
      return Object.freeze({ saleId: completed.saleId, status: "Completed", completedAt: completed.completedAt, grossRevenue: completed.snapshot.grossRevenue, netRevenue: completed.snapshot.netRevenue, itemCost: completed.snapshot.itemCost, profit: completed.snapshot.profit, financialSnapshotId: input.financialSnapshotId, financeEntryId: input.financeEntryId, completionHistoryId: input.completionHistoryId, replayed: completed.replay });
    } catch (error) {
      if (error instanceof SaleConcurrencyConflictError || error instanceof SalesCompletionIdempotencyConflictError || error instanceof SaleAlreadyCompletedConflictError || error instanceof SalesUseCaseError) throw error;
      const causeCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      throw new SalesCompletionCoordinationError("completion", causeCode);
    }
  }
}
