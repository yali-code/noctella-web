import { createHash, randomUUID } from "node:crypto";
import { BadRequestError, ConflictError, InvoiceCostSetBlockedError, NotFoundError } from "../../services/errors";
import type { FxRateLookup } from "../../services/ecbReferenceRates";
import type { CostSetProductFacts, InvoiceCostSetRecord, InvoiceIntakeRecord, InvoiceIntakeRepository } from "../../repositories/invoice-intake/types";
import { ALLOCATABLE_INVOICE_TYPES, allocateCostSet, officialEurCents, type AllocationIntakeInput, type CostSetAllocation, type CostSetIssue } from "./costAllocation";
import { toCents } from "./invoiceReview";
import { invoiceIntakeReviewView, loadIntakeInOpenSet, loadOpenCostSet } from "./useCases";

/**
 * PHASE-2C: official FX + bank debit, product selection with value weights, allocation preview, and approve ->
 * one Draft purchase through the canonical purchase command path (behind PurchaseCommandPort; the application
 * service wires it to executePurchaseCommand). No stock change, no Receive, no Mark Ordered here.
 */
export const COST_SET_PURCHASE_REFERENCE_PREFIX = "invoice-cost-set:";
export const costSetPurchaseReference = (costSetId: string) => `${COST_SET_PURCHASE_REFERENCE_PREFIX}${costSetId}`;
const CANDIDATE_LIMIT = 50;
const now = () => new Date().toISOString();
const eur = (cents: number) => cents / 100;

export interface PurchaseCommandPort {
  /** CreatePurchase through the canonical command path; returns the purchase id. */
  createPurchase(payload: CreatePurchasePayload, idempotencyKey: string): Promise<{ id: string }>;
  /** AllocatePurchaseCosts with method Equal through the canonical command path. */
  allocateEqual(purchaseId: string, idempotencyKey: string): Promise<void>;
}

export interface CreatePurchasePayload {
  erpReferenceId: string;
  sourceType: "Auction";
  currency: "EUR";
  invoiceReferenceNumber: string | null;
  auctionHouse: string | null;
  auctionDate: string | null;
  notes: string;
  buyerPremium: 0;
  shippingCost: 0;
  customsCost: 0;
  packagingCost: 0;
  taxVat: 0;
  miscellaneousCost: 0;
  lines: Array<{ productId: string; titleSnapshot: string; quantity: 1; unitPurchaseCost: number; sourceLineReference: string | null }>;
}

/** 1) Stores the bank/card EUR debit and the official ECB rate on the paid date. Re-running overwrites both. */
export async function setIntakeBankDebitAndRateUseCase(deps: { repository: InvoiceIntakeRepository; fxRate: FxRateLookup }, intakeId: string, bankDebitEur: number) {
  const intake = await loadIntakeInOpenSet(deps.repository, intakeId);
  if (intake.status !== "reviewed") throw new ConflictError("Confirm the invoice review before entering the bank debit");
  if (!(ALLOCATABLE_INVOICE_TYPES as readonly string[]).includes(intake.invoiceType as string)) throw new BadRequestError("Only auction, transport and forwarder invoices can be allocated");
  if (!intake.paidDate) throw new BadRequestError("The invoice has no paid date; add it in the review first");
  if (!intake.currency) throw new BadRequestError("The invoice has no currency; add it in the review first");
  if (!Number.isFinite(bankDebitEur) || toCents(bankDebitEur) <= 0) throw new BadRequestError("Bank debit must be above 0");

  const rate = await deps.fxRate(String(intake.currency), String(intake.paidDate));
  const result = await deps.repository.updateIntakeFx({
    id: intakeId, expectedStatuses: ["reviewed"], nextStatus: "reviewed", updatedAt: now(),
    values: { fxRate: rate.rate, fxRateDate: rate.rateDate, fxSource: rate.source, bankDebitEur: eur(toCents(bankDebitEur)) },
  });
  if (result.updated) return result.row!;
  if (result.conflict?.field === "id") throw new NotFoundError("Invoice intake not found");
  throw new ConflictError("Invoice intake changed; reload and try again");
}

/** Official EUR and FX difference of one intake for display; null until both the rate and the bank debit exist. */
export function intakeFxSummary(intake: InvoiceIntakeRecord) {
  const total = intake.totalOriginal as number | null;
  const rate = intake.fxRate as number | null;
  const bank = intake.bankDebitEur as number | null;
  if (total == null || rate == null || rate <= 0) return null;
  const official = officialEurCents(total, rate);
  return { officialEur: eur(official), fxDiffEur: bank == null ? null : eur(toCents(bank) - official) };
}

/** 2) Helper read for the picker: AI-intake products not on a live purchase line and not in another open/approved set. */
export async function listCostSetProductCandidatesUseCase(deps: { repository: InvoiceIntakeRepository }, costSetId: string, query: string) {
  await loadOpenCostSet(deps.repository, costSetId);
  return deps.repository.listProductCandidates({ costSetId, query: query ?? "", limit: CANDIDATE_LIMIT, ownPurchaseReference: costSetPurchaseReference(costSetId) });
}

/**
 * PHASE-2C-1: effective weight per item: admin value ('admin', kept as entered; <= 0 blocks as MISSING_WEIGHT)
 * > AI estimate > 0 ('ai') > fallback = average of the set's AI estimates, rounded to cents, or 1 when the set has
 * none. A fallback is stored with weight_source NULL (the column only allows 'ai' | 'admin').
 */
export function resolveCostSetWeights(items: Array<{ adminWeightEur: number | null; aiSuggestedPriceEur: number | null }>) {
  const aiCents = items.map((i) => (i.aiSuggestedPriceEur != null ? toCents(i.aiSuggestedPriceEur) : 0)).filter((c) => c > 0);
  const fallback = aiCents.length ? eur(Math.round(aiCents.reduce((a, b) => a + b, 0) / aiCents.length)) : 1;
  return items.map((i) => {
    if (i.adminWeightEur != null) return { valueWeightEur: i.adminWeightEur, weightSource: "admin" as const };
    if (i.aiSuggestedPriceEur != null && toCents(i.aiSuggestedPriceEur) > 0) return { valueWeightEur: i.aiSuggestedPriceEur, weightSource: "ai" as const };
    return { valueWeightEur: fallback, weightSource: null };
  });
}

/** API label of a stored weight: a value with a NULL source is the fallback (average). */
const weightSourceLabel = (valueWeightEur: number | null, weightSource: string | null) => weightSource ?? (valueWeightEur != null ? "fallback" : null);

/** 2) Replaces the set's products. Weights per resolveCostSetWeights; an admin value overrides ('admin'). */
export async function setCostSetProductsUseCase(deps: { repository: InvoiceIntakeRepository }, costSetId: string, items: Array<{ productId: string; valueWeightEur?: number | null }>) {
  await loadOpenCostSet(deps.repository, costSetId);
  const ids = items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) throw new BadRequestError("A product is selected more than once");
  for (const i of items) if (i.valueWeightEur != null && !(Number.isFinite(i.valueWeightEur) && toCents(i.valueWeightEur) > 0)) throw new BadRequestError("A value weight must be above 0");

  const facts = new Map((await deps.repository.findProductFacts(ids)).map((f) => [f.productId, f]));
  const missing = ids.filter((id) => !facts.has(id));
  if (missing.length) throw new NotFoundError("A selected product was not found");
  const conflicts = await deps.repository.findProductConflicts({ costSetId, productIds: ids, ownPurchaseReference: costSetPurchaseReference(costSetId) });
  if (conflicts.onPurchase.length) throw new ConflictError(`Already on a purchase: ${conflicts.onPurchase.map((id) => facts.get(id)!.sku).join(", ")}`);
  if (conflicts.inOtherSet.length) throw new ConflictError(`Already in another open or approved cost set: ${conflicts.inOtherSet.map((id) => facts.get(id)!.sku).join(", ")}`);

  const weights = resolveCostSetWeights(items.map((i) => ({ adminWeightEur: i.valueWeightEur ?? null, aiSuggestedPriceEur: facts.get(i.productId)!.aiSuggestedPriceEur })));
  const rows = items.map((i, k) => ({ id: randomUUID(), productId: i.productId, ...weights[k] }));
  await deps.repository.replaceCostSetItems(costSetId, rows, now());
  return costSetItemsView(deps.repository, costSetId);
}

/** The set's items joined with their product facts, in selection order. */
export async function costSetItemsView(repository: InvoiceIntakeRepository, costSetId: string) {
  const items = await repository.listCostSetItems(costSetId);
  const facts = new Map((await repository.findProductFacts(items.map((i) => String(i.productId)))).map((f) => [f.productId, f]));
  return items.map((i) => {
    const f: CostSetProductFacts | undefined = facts.get(String(i.productId));
    return {
      productId: i.productId as string, sku: f?.sku ?? null, title: f?.title ?? null, aiSuggestedPriceEur: f?.aiSuggestedPriceEur ?? null, purchaseCost: f?.purchaseCost ?? null,
      valueWeightEur: i.valueWeightEur as number | null, weightSource: weightSourceLabel(i.valueWeightEur as number | null, i.weightSource as string | null),
      allocLotEur: i.allocLotEur as number | null, allocHammerFeeEur: i.allocHammerFeeEur as number | null, allocPremiumEur: i.allocPremiumEur as number | null,
      allocTransportEur: i.allocTransportEur as number | null, allocForwarderEur: i.allocForwarderEur as number | null, allocFxDiffEur: i.allocFxDiffEur as number | null,
      allocTotalEur: i.allocTotalEur as number | null,
    };
  });
}

function allocationIntake(intake: InvoiceIntakeRecord): AllocationIntakeInput {
  return {
    id: intake.id as string, status: intake.status as string, invoiceType: intake.invoiceType as string, invoiceNumber: (intake.invoiceNumber as string) ?? null,
    currency: (intake.currency as string) ?? null, fxRate: (intake.fxRate as number) ?? null, fxRateDate: (intake.fxRateDate as string) ?? null, fxSource: (intake.fxSource as string) ?? null,
    bankDebitEur: (intake.bankDebitEur as number) ?? null, values: intake.status === "reviewed" ? invoiceIntakeReviewView(intake)?.effective ?? null : null,
  };
}

/** Re-resolves the non-admin weights from the current AI estimates (admin weights are kept) and persists any change. */
async function refreshCostSetWeights(repository: InvoiceIntakeRepository, costSetId: string) {
  const items = await costSetItemsView(repository, costSetId);
  const weights = resolveCostSetWeights(items.map((i) => ({ adminWeightEur: i.weightSource === "admin" ? i.valueWeightEur : null, aiSuggestedPriceEur: i.aiSuggestedPriceEur })));
  const changed = items.map((i, k) => ({ productId: i.productId, ...weights[k] }))
    .filter((w, k) => w.valueWeightEur !== items[k].valueWeightEur || weightSourceLabel(w.valueWeightEur, w.weightSource) !== items[k].weightSource);
  if (changed.length) await repository.saveCostSetItemWeights(costSetId, changed, now());
}

/** Computes the allocation from current data (re-checking product conflicts) and persists alloc_* (null when blocked). */
async function computeAndStorePreview(repository: InvoiceIntakeRepository, costSetId: string) {
  await refreshCostSetWeights(repository, costSetId);
  const [intakes, items] = await Promise.all([repository.listIntakesByCostSet(costSetId), costSetItemsView(repository, costSetId)]);
  const allocation = allocateCostSet(intakes.map(allocationIntake), items.map((i) => ({
    productId: i.productId, sku: i.sku, title: i.title, valueWeightEur: i.valueWeightEur, weightSource: i.weightSource, purchaseCost: i.purchaseCost,
  })));
  const conflicts = await repository.findProductConflicts({ costSetId, productIds: items.map((i) => i.productId), ownPurchaseReference: costSetPurchaseReference(costSetId) });
  const sku = (id: string) => items.find((i) => i.productId === id)?.sku ?? id;
  const conflictIssues: CostSetIssue[] = [
    ...conflicts.onPurchase.map((id) => ({ code: "PRODUCT_ON_PURCHASE", productId: id, message: `${sku(id)} is already on a purchase` })),
    ...conflicts.inOtherSet.map((id) => ({ code: "PRODUCT_IN_OTHER_SET", productId: id, message: `${sku(id)} is already in another open or approved cost set` })),
  ];
  const result: CostSetAllocation = conflictIssues.length ? { ...allocation, issues: [...allocation.issues, ...conflictIssues] } : allocation;
  const ok = result.issues.length === 0;
  await repository.saveCostSetItemAllocations(costSetId, items.map((i) => {
    const a = ok ? result.items.find((x) => x.productId === i.productId)! : null;
    return {
      productId: i.productId,
      allocLotEur: a ? eur(a.lotCents) : null, allocHammerFeeEur: a ? eur(a.hammerFeeCents) : null, allocPremiumEur: a ? eur(a.premiumCents) : null,
      allocTransportEur: a ? eur(a.transportCents) : null, allocForwarderEur: a ? eur(a.forwarderCents) : null, allocFxDiffEur: a ? eur(a.fxDiffCents) : null,
      allocTotalEur: a ? eur(a.totalCents) : null,
    };
  }), now());
  return { allocation: result, intakes, items };
}

export function allocationView(allocation: CostSetAllocation) {
  return {
    issues: allocation.issues,
    warnings: allocation.warnings,
    intakes: allocation.intakes.map((i) => ({
      intakeId: i.intakeId, invoiceType: i.invoiceType, invoiceNumber: i.invoiceNumber, currency: i.currency, totalOriginal: i.totalOriginal,
      fxRate: i.fxRate, fxRateDate: i.fxRateDate, fxSource: i.fxSource, officialEur: eur(i.officialEurCents), bankDebitEur: eur(i.bankDebitCents), fxDiffEur: eur(i.fxDiffCents),
    })),
    items: allocation.items.map((i) => ({
      productId: i.productId, sku: i.sku, title: i.title, lotEur: eur(i.lotCents), hammerFeeEur: eur(i.hammerFeeCents), premiumEur: eur(i.premiumCents),
      transportEur: eur(i.transportCents), forwarderEur: eur(i.forwarderCents), fxDiffEur: eur(i.fxDiffCents), totalEur: eur(i.totalCents),
    })),
    totalBankDebitEur: eur(allocation.totalBankDebitCents),
    totalAllocatedEur: eur(allocation.totalAllocatedCents),
  };
}

/** 3) Preview: per-item breakdown, per-invoice official/bank/fxDiff, issues and warnings; persists alloc_* on the items. */
export async function previewCostSetAllocationUseCase(deps: { repository: InvoiceIntakeRepository }, costSetId: string) {
  await loadOpenCostSet(deps.repository, costSetId);
  const { allocation } = await computeAndStorePreview(deps.repository, costSetId);
  return allocationView(allocation);
}

const signed = (cents: number) => `${cents >= 0 ? "+" : "-"}${(Math.abs(cents) / 100).toFixed(2)}`;

export function buildCreatePurchasePayload(costSetId: string, allocation: CostSetAllocation, intakes: InvoiceIntakeRecord[], items: Array<{ productId: string; sku: string | null; title: string | null }>): CreatePurchasePayload {
  const active = intakes.filter((i) => i.status !== "cancelled");
  const auction = active.find((i) => i.invoiceType === "auction")!;
  const numbers = active.map((i) => i.invoiceNumber as string | null).filter((n): n is string => !!n);
  const audit = allocation.intakes.map((i) =>
    `${i.invoiceType} ${i.invoiceNumber ?? i.intakeId}: ${Number(i.totalOriginal).toFixed(2)} ${i.currency} @ ${i.fxSource} ${i.fxRate} (${i.fxRateDate}) = official ${(i.officialEurCents / 100).toFixed(2)} EUR; bank ${(i.bankDebitCents / 100).toFixed(2)} EUR; FX diff ${signed(i.fxDiffCents)} EUR`);
  const lotRef = allocation.lotNumbers.length ? allocation.lotNumbers.join(", ") : null;
  return {
    erpReferenceId: costSetPurchaseReference(costSetId),
    sourceType: "Auction",
    currency: "EUR",
    invoiceReferenceNumber: numbers.length ? numbers.join(", ") : null,
    auctionHouse: (auction.supplierName as string) ?? null,
    auctionDate: (auction.issueDate as string) ?? null,
    notes: [...audit, `Invoice cost set ${costSetId}`].join("\n"),
    // No header fees: every cost is already in the line's unit cost. Explicit zeros keep the purchase total complete.
    buyerPremium: 0, shippingCost: 0, customsCost: 0, packagingCost: 0, taxVat: 0, miscellaneousCost: 0,
    lines: allocation.items.map((a) => {
      const item = items.find((i) => i.productId === a.productId)!;
      const title = item.title ?? a.productId;
      return { productId: a.productId, titleSnapshot: item.sku ? `${title} [${item.sku}]` : title, quantity: 1 as const, unitPurchaseCost: eur(a.totalCents), sourceLineReference: lotRef };
    }),
  };
}

const lineKey = (l: { productId: string | null; quantity: number; unitPurchaseCost: number }) => `${l.productId}|${l.quantity}|${toCents(l.unitPurchaseCost)}`;
const sameLines = (a: Array<Parameters<typeof lineKey>[0]>, b: Array<Parameters<typeof lineKey>[0]>) =>
  a.length === b.length && JSON.stringify(a.map(lineKey).sort()) === JSON.stringify(b.map(lineKey).sort());

/**
 * 4) Approve: re-run the preview (blocked on issues), create the Draft purchase through the canonical command path
 * (or reuse the one already created for this set via its erpReferenceId), allocate Equal, then the atomic
 * conditional open -> approved with purchase_id. A retry after a failure between the purchase and the set update
 * reuses the purchase; the idempotency key carries a payload hash so a changed selection never replays stale data.
 */
export async function approveCostSetUseCase(deps: { repository: InvoiceIntakeRepository; purchases: PurchaseCommandPort }, input: { costSetId: string; approvedBy?: string | null }): Promise<InvoiceCostSetRecord> {
  const { costSetId } = input;
  await loadOpenCostSet(deps.repository, costSetId);
  const { allocation, intakes, items } = await computeAndStorePreview(deps.repository, costSetId);
  if (allocation.issues.length) throw new InvoiceCostSetBlockedError(allocation.issues);

  const payload = buildCreatePurchasePayload(costSetId, allocation, intakes, items);
  const reference = payload.erpReferenceId;
  let purchaseId: string;
  const existing = await deps.repository.findPurchaseByErpReference(reference);
  if (existing) {
    if (existing.status === "Cancelled") throw new ConflictError("The purchase created for this cost set was cancelled; it cannot be reused");
    // Only a Draft purchase may be reused: an ordered or received purchase must never be re-allocated or approved here.
    if (existing.status !== "Draft") {
      throw new InvoiceCostSetBlockedError([{ code: "PURCHASE_NOT_DRAFT", message: `The purchase for this cost set (${existing.id}) is ${existing.status}, not Draft; it cannot be reused` }]);
    }
    if (!sameLines(existing.lines, payload.lines)) throw new ConflictError(`A purchase for this cost set already exists (${existing.id}) with different lines; restore the previous selection or cancel that purchase`);
    purchaseId = existing.id;
  } else {
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
    purchaseId = (await deps.purchases.createPurchase(payload, `${reference}:create:${hash}`)).id;
  }
  await deps.purchases.allocateEqual(purchaseId, `${reference}:allocate:${purchaseId}`);

  const t = now();
  const result = await deps.repository.approveCostSet({ id: costSetId, purchaseId, approvedBy: input.approvedBy?.trim() || "admin", approvedAt: t, updatedAt: t });
  if (result.updated) return result.row!;
  if (result.conflict?.field === "id") throw new NotFoundError("Invoice cost set not found");
  throw new ConflictError("Only an open invoice cost set can be approved");
}

/** Read-only cost breakdown of a product from its approved cost set; null when none exists. Reads stored allocation values only. */
export async function getProductCostBreakdownUseCase(deps: { repository: InvoiceIntakeRepository }, productId: string) {
  const found = await deps.repository.findApprovedCostSetItemByProduct(productId);
  if (!found) return null;
  const { costSet, item } = found;
  const amount = (value: unknown) => Number(value ?? 0);
  return {
    currency: "EUR" as const,
    costSetId: costSet.id as string,
    costSetTitle: costSet.title as string,
    purchaseId: (costSet.purchaseId as string | null) ?? null,
    goodsEur: eur(toCents(amount(item.allocLotEur)) + toCents(amount(item.allocHammerFeeEur)) + toCents(amount(item.allocPremiumEur))),
    transportEur: eur(toCents(amount(item.allocTransportEur)) + toCents(amount(item.allocForwarderEur))),
    fxDifferenceEur: amount(item.allocFxDiffEur),
    totalEur: amount(item.allocTotalEur),
  };
}
