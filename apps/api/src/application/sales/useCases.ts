import type { SalesApplicationContext } from "../../services/salesApplicationContext";
import type { Sale, SaleRepository, UpdateSaleInput as RepositoryUpdateSaleInput } from "../../repositories/sales/types";
import { InvalidSaleAmountError, InvalidSaleStatusTransitionError, SaleConcurrencyConflictError, SaleDuplicateReferenceError, SaleNotFoundError, SalesValidationError } from "./errors";
import type { CancelSaleInput, CreateSaleInput, GetSaleInput, ListSalesInput, SaleListOutput, SaleOutput, UpdateSaleInput } from "./types";

const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const positiveQuantity = (value: number) => Number.isInteger(value) && value > 0;
const required = (value: string, label: string) => { if (!value.trim()) throw new SalesValidationError(`${label} is required`); };
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
function output(sale: Sale): SaleOutput {
  const lines = sale.lines.map((line) => frozen({ ...line })) as readonly SaleOutput["lines"][number][];
  return frozen({ ...sale, customer: frozen({ ...sale.customer }), payment: frozen({ ...sale.payment }), fulfillment: frozen({ ...sale.fulfillment }), marketplace: frozen({ ...sale.marketplace }), financials: frozen({ ...sale.financials }), receipt: frozen({ ...sale.receipt }), lines: frozen([...lines]) }) as SaleOutput;
}
function transactionRepository(ctx: SalesApplicationContext, work: (repository: SaleRepository) => Sale | SaleListOutput): Promise<Sale | SaleListOutput> {
  return ctx.unitOfWork.run(({ repositories }) => work(repositories.sales.saleRepository));
}
function validateCurrency(currency: string) { if (currency !== "EUR") throw new InvalidSaleAmountError("Sales currency must be EUR"); }
const terminal = new Set(["Completed", "Cancelled", "Refunded"]);
const transitions: Readonly<Record<string, readonly string[]>> = frozen({ Pending: frozen(["Processing", "Paid"]), Processing: frozen(["Paid", "Shipped"]), Paid: frozen(["Shipped"]), Shipped: frozen(["Delivered"]), Delivered: frozen([]) });
function assertTransition(from: string, to: string) { if (from === to || terminal.has(to) || !(transitions[from] ?? []).includes(to)) throw new InvalidSaleStatusTransitionError(); }
function result(value: ReturnType<SaleRepository["updateWithVersion"]>): Sale {
  if (value.ok) return value.value;
  if (value.issue.code === "not_found") throw new SaleNotFoundError();
  if (value.issue.code === "optimistic_conflict") throw new SaleConcurrencyConflictError();
  throw new SalesValidationError(value.issue.message);
}

export class CreateSaleUseCase {
  constructor(private readonly ctx: SalesApplicationContext) {}
  async execute(input: CreateSaleInput): Promise<SaleOutput> {
    validateCurrency(input.currency); required(input.reference, "Sale reference");
    if (!input.lines.length) throw new SalesValidationError("Sale requires at least one line");
    if (!nonnegative(input.shippingAmount) || !nonnegative(input.taxAmount)) throw new InvalidSaleAmountError();
    for (const line of input.lines) { required(line.title, "Line title"); if (!positiveQuantity(line.quantity)) throw new SalesValidationError("Sale quantity must be a positive integer"); if (!nonnegative(line.unitPrice)) throw new InvalidSaleAmountError("Sale unit price must not be negative"); }
    const created = await transactionRepository(this.ctx, (repository) => {
      const replay = input.idempotencyKey ? repository.findByIdempotencyKey(input.idempotencyKey) : null;
      if (replay) return replay;
      if (repository.findByReference(input.reference)) throw new SaleDuplicateReferenceError();
      if (input.marketplace?.externalOrderId && repository.findByExternalOrderId(input.marketplace.externalOrderId)) throw new SaleDuplicateReferenceError();
      const timestamp = this.ctx.clock.now().toISOString(); const saleId = this.ctx.idGenerator.newId();
      const lines = input.lines.map((line) => { const totalPrice = line.quantity * line.unitPrice; return { id: this.ctx.idGenerator.newId(), saleId, productId: line.productId ?? null, sku: line.sku ?? null, title: line.title, slug: line.slug ?? null, productType: line.productType ?? null, imageUrl: line.imageUrl ?? null, quantity: line.quantity, unitPrice: line.unitPrice, totalPrice, currency: "EUR" as const, stockMovementId: null, createdAt: timestamp, updatedAt: timestamp }; });
      const subtotalAmount = lines.reduce((sum, line) => sum + line.totalPrice, 0); const totalAmount = subtotalAmount + input.shippingAmount + input.taxAmount;
      return repository.create({ id: saleId, reference: input.reference, orderDraftId: input.orderDraftId ?? null, source: input.source, status: input.status, paymentStatus: input.paymentStatus, customer: { customerId: input.customer?.customerId ?? null, email: input.customer?.email ?? null, billingAddress: input.customer?.billingAddress ?? null, shippingAddress: input.customer?.shippingAddress ?? null }, payment: { status: input.paymentStatus, provider: input.paymentProvider ?? null, reference: input.paymentReference ?? null }, fulfillment: { status: input.shipping?.status ?? null, shippingStatus: input.shipping?.shippingStatus ?? null, trackingNumber: input.shipping?.trackingNumber ?? null }, marketplace: { channel: input.marketplace?.channel ?? null, marketplaceOrderId: input.marketplace?.marketplaceOrderId ?? null, externalOrderId: input.marketplace?.externalOrderId ?? null, externalOrderNumber: input.marketplace?.externalOrderNumber ?? null, externalTransactionId: input.marketplace?.externalTransactionId ?? null, connectionId: input.marketplace?.connectionId ?? null }, financials: { subtotalAmount, shippingAmount: input.shippingAmount, taxAmount: input.taxAmount, totalAmount, grossRevenue: null, shippingCharged: null, shippingCost: null, marketplaceFee: null, promotedFee: null, paymentFee: null, itemCost: null, netRevenue: null, profit: null, currency: "EUR" }, receipt: { invoiceId: null, invoiceNumber: null }, notes: input.notes ?? null, idempotencyKey: input.idempotencyKey ?? null, createdAt: timestamp, updatedAt: timestamp, completedAt: null, lines });
    });
    return output(created as Sale);
  }
}

export class UpdateSaleUseCase {
  constructor(private readonly ctx: SalesApplicationContext) {}
  async execute(input: UpdateSaleInput): Promise<SaleOutput> {
    validateCurrency(input.currency);
    const updated = await transactionRepository(this.ctx, (repository) => { const current = repository.findById(input.saleId); if (!current) throw new SaleNotFoundError(); if (terminal.has(current.status)) throw new InvalidSaleStatusTransitionError(); if (input.reference !== undefined) { required(input.reference, "Sale reference"); const duplicate = repository.findByReference(input.reference); if (duplicate && duplicate.id !== input.saleId) throw new SaleDuplicateReferenceError(); } if (input.status !== undefined) assertTransition(current.status, input.status); const change: RepositoryUpdateSaleInput = { updatedAt: this.ctx.clock.now().toISOString(), ...(input.reference !== undefined ? { reference: input.reference } : {}), ...(input.status !== undefined ? { status: input.status } : {}), ...(input.customer !== undefined ? { customer: { customerId: input.customer.customerId ?? null, email: input.customer.email ?? null, billingAddress: input.customer.billingAddress ?? null, shippingAddress: input.customer.shippingAddress ?? null } } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) }; return result(repository.updateWithVersion(input.saleId, input.expectedVersion, change)); });
    return output(updated as Sale);
  }
}
export class GetSaleUseCase { constructor(private readonly ctx: SalesApplicationContext) {} async execute(input: GetSaleInput): Promise<SaleOutput> { const sale = this.ctx.saleRepository.findById(input.saleId); if (!sale) throw new SaleNotFoundError(); return output(sale); } }
export class ListSalesUseCase { constructor(private readonly ctx: SalesApplicationContext) {} async execute(input: ListSalesInput = {}): Promise<SaleListOutput> { const page = this.ctx.saleRepository.list(input); return frozen({ rows: frozen(page.rows.map(output)), total: page.total, limit: page.limit, offset: page.offset }); } }
export class CancelSaleUseCase { constructor(private readonly ctx: SalesApplicationContext) {} async execute(input: CancelSaleInput): Promise<SaleOutput> { const cancelled = await transactionRepository(this.ctx, (repository) => { const current = repository.findById(input.saleId); if (!current) throw new SaleNotFoundError(); if (current.status === "Cancelled" || terminal.has(current.status)) throw new InvalidSaleStatusTransitionError(); return result(repository.updateWithVersion(input.saleId, input.expectedVersion, { status: "Cancelled", updatedAt: this.ctx.clock.now().toISOString() })); }); return output(cancelled as Sale); } }
