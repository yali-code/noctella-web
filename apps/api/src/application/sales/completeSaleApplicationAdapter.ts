import { createHash } from "node:crypto";
import type { Sale, SaleLine } from "../../repositories/sales/types";
import type { SalesApplicationContext } from "../../services/salesApplicationContext";
import { CompleteSaleUseCase } from "./completeSaleUseCase";
import type { CompleteSaleInput, CompleteSaleResult } from "./completeSaleTypes";
import type { SalesCompletionFinancialSnapshot } from "./completionCoordination";
import { SaleNotFoundError } from "./errors";

export interface LegacySaleFinancials extends SalesCompletionFinancialSnapshot {
  readonly id: string;
  readonly orderId: string;
  readonly sourceSnapshot: string;
  readonly createdAt: string;
}
export interface LegacyCompletionReadiness { readonly orderId: string; readonly ready: boolean; readonly issues: readonly string[]; readonly shipment: { readonly id: string; readonly shippingCost: number } | null }
export type LegacyCompleteSaleResponse =
  | Readonly<{ orderId: string; status: "blocked"; alreadyCompleted: false; issues: readonly string[] }>
  | Readonly<{ orderId: string; status: "completed"; completedAt: string; alreadyCompleted: boolean; financials: LegacySaleFinancials; issues: readonly string[] }>;
export interface CompleteSaleAdapterPorts {
  findFinancials(orderId: string): Promise<LegacySaleFinancials | null>;
  getReadiness(orderId: string): Promise<LegacyCompletionReadiness>;
  getProductCosts(lines: readonly SaleLine[]): Promise<ReadonlyMap<string, number | null>>;
  prepareSourceSnapshot(sale: Sale): Promise<string>;
}

const fingerprint = (sale: Sale, snapshot: Omit<SalesCompletionFinancialSnapshot, "completedAt">) =>
  `sha256:${createHash("sha256").update(JSON.stringify({ saleId: sale.id, expectedVersion: sale.updatedAt, snapshot })).digest("hex")}`;

export class CompleteSaleApplicationAdapter {
  constructor(private readonly context: SalesApplicationContext, private readonly ports: CompleteSaleAdapterPorts, private readonly useCase?: CompleteSaleUseCase) {}

  async execute(orderId: string): Promise<LegacyCompleteSaleResponse> {
    const existing = await this.ports.findFinancials(orderId);
    if (existing) return this.toLegacyResponse(orderId, existing, true);
    const readiness = await this.ports.getReadiness(orderId);
    if (!readiness.ready) return Object.freeze({ orderId, status: "blocked", alreadyCompleted: false, issues: Object.freeze([...readiness.issues]) });
    const sale = await this.context.saleRepository.findById(orderId);
    if (!sale) throw new SaleNotFoundError();
    const costs = await this.ports.getProductCosts(sale.lines);
    const itemCost = sale.lines.reduce((total, line) => total + (costs.get(line.productId ?? "") ?? 0) * line.quantity, 0);
    const shippingCost = readiness.shipment?.shippingCost ?? 0;
    const completedAt = this.context.clock.now().toISOString();
    const values = Object.freeze({ saleId: sale.id, grossRevenue: sale.financials.totalAmount, shippingCharged: sale.financials.shippingAmount, shippingCost, marketplaceFee: null, promotedFee: null, paymentFee: null, taxVat: sale.financials.taxAmount, itemCost, netRevenue: sale.financials.totalAmount - sale.financials.taxAmount - shippingCost, profit: sale.financials.totalAmount - sale.financials.taxAmount - shippingCost - itemCost, currency: "EUR" as const });
    const snapshot = Object.freeze({ ...values, completedAt });
    const idempotencyKey = `complete-sale:${sale.id}`;
    const financialSnapshotId = this.context.idGenerator.newId();
    const financeEntryId = this.context.idGenerator.newId();
    const completionHistoryId = readiness.shipment ? this.context.idGenerator.newId() : null;
    const sourceSnapshot = await this.ports.prepareSourceSnapshot(sale);
    const input: CompleteSaleInput = Object.freeze({ expectedVersion: sale.updatedAt, idempotencyKey, payloadFingerprint: fingerprint(sale, values), financialSnapshotId, financeEntryId, completionHistoryId, finalUpdatedAt: completedAt, snapshot, financeEntry: Object.freeze({ saleId: sale.id, entryType: "CompleteSale", amount: snapshot.grossRevenue, currency: "EUR", sourceReference: sale.id, idempotencyKey, occurredAt: completedAt, snapshot }), historyEntry: readiness.shipment ? Object.freeze({ saleId: sale.id, shipmentId: readiness.shipment.id, eventType: "sale_completed", occurredAt: completedAt, financialSnapshot: snapshot }) : null });
    const projectedContext = Object.freeze({ ...this.context, saleRepository: Object.freeze({ ...this.context.saleRepository, findById: (id: string) => { const found = this.context.saleRepository.findById(id); return found && id === sale.id ? Object.freeze({ ...found, status: "Delivered", paymentStatus: "Paid", payment: Object.freeze({ ...found.payment, status: "Paid" }) }) : found; } }) });
    const result = await (this.useCase ?? new CompleteSaleUseCase(projectedContext)).execute(input);
    if (result.replayed) {
      const replay = await this.ports.findFinancials(orderId);
      if (replay) return this.toLegacyResponse(orderId, replay, true);
    }
    return this.mapUseCaseResult(result, financialSnapshotId, snapshot, sourceSnapshot);
  }

  private mapUseCaseResult(result: CompleteSaleResult, financialSnapshotId: string, snapshot: SalesCompletionFinancialSnapshot, sourceSnapshot: string): LegacyCompleteSaleResponse {
    const financials = Object.freeze({ id: financialSnapshotId, orderId: result.saleId, ...snapshot, sourceSnapshot, completedAt: result.completedAt, createdAt: result.completedAt });
    return this.toLegacyResponse(result.saleId, financials, result.replayed);
  }

  private toLegacyResponse(orderId: string, financials: LegacySaleFinancials, replay: boolean): LegacyCompleteSaleResponse { return Object.freeze({ orderId, status: "completed", completedAt: financials.completedAt, alreadyCompleted: replay, financials, issues: Object.freeze([]) }); }
}
