import { getProductCostBreakdownUseCase } from "../use-cases/invoice-intake/costSetUseCases";
import type { DbClient } from "../db/client";
import { createInvoiceIntakeRepository } from "../repositories/invoice-intake/factory";
import type { InvoiceCostSetRecord, InvoiceIntakeRecord, InvoiceIntakeRepository } from "../repositories/invoice-intake/types";
import { invoiceFileStorage, type InvoiceFileStorage } from "./invoiceFileStorage";
import {
  addInvoiceIntakeFileUseCase,
  cancelInvoiceCostSetUseCase,
  cancelInvoiceIntakeUseCase,
  createInvoiceCostSetUseCase,
  extractInvoiceIntakeUseCase,
  getInvoiceCostSetUseCase,
  getInvoiceIntakeFileUseCase,
  invoiceIntakeReviewView,
  listInvoiceCostSetsUseCase,
  reviewInvoiceIntakeUseCase,
} from "../use-cases/invoice-intake/useCases";
import type { InvoiceEdits } from "../use-cases/invoice-intake/invoiceReview";
import { createInvoiceExtractor, type InvoiceExtractor } from "../ai-intake/openAiInvoiceExtractor";
import {
  approveCostSetUseCase,
  costSetItemsView,
  intakeFxSummary,
  listCostSetProductCandidatesUseCase,
  previewCostSetAllocationUseCase,
  setCostSetProductsUseCase,
  setIntakeBankDebitAndRateUseCase,
  type PurchaseCommandPort,
} from "../use-cases/invoice-intake/costSetUseCases";
import { ecbRateLookup, type FxRateLookup } from "./ecbReferenceRates";
import { executePurchaseCommand } from "./erpPurchasingBridge";

/**
 * PHASE-2A application service: orchestration and output mapping only - business rules live in
 * use-cases/invoice-intake/useCases.ts. Driver resolution mirrors services/aiProductIntakes.ts. The stored
 * relative path is deliberately not part of any API output; files are served only via the intake file route.
 */
function repositoryFor(db: DbClient): InvoiceIntakeRepository {
  return createInvoiceIntakeRepository((process.env.DATABASE_DRIVER as string) || "sqlite", db);
}

function toCostSet(row: InvoiceCostSetRecord) {
  return {
    id: row.id, status: row.status, title: row.title, purchaseId: row.purchaseId ?? null,
    approvedBy: row.approvedBy ?? null, approvedAt: row.approvedAt ?? null, notes: row.notes ?? null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/** PHASE-2B: the raw extraction/edits JSON is replaced by the review view (effective values, evidence, checks). */
function toIntake(row: InvoiceIntakeRecord) {
  const { fileRelativePath: _omitted, extractionJson: _extraction, editsJson: _edits, ...rest } = row;
  return { ...rest, review: invoiceIntakeReviewView(row), fx: intakeFxSummary(row) };
}

export async function createInvoiceCostSet(db: DbClient, input: { title: string; notes?: string | null }) {
  return toCostSet(await createInvoiceCostSetUseCase({ repository: repositoryFor(db) }, input));
}

export async function listInvoiceCostSets(db: DbClient, query: { page: number; pageSize: number; status?: string }) {
  const result = await listInvoiceCostSetsUseCase({ repository: repositoryFor(db) }, query);
  return { ...result, items: result.items.map(toCostSet) };
}

export async function getInvoiceCostSet(db: DbClient, id: string) {
  const repository = repositoryFor(db);
  const { costSet, intakes } = await getInvoiceCostSetUseCase({ repository }, id);
  return { ...toCostSet(costSet), intakes: intakes.map(toIntake), items: await costSetItemsView(repository, id) };
}

export async function cancelInvoiceCostSet(db: DbClient, id: string) {
  return toCostSet(await cancelInvoiceCostSetUseCase({ repository: repositoryFor(db) }, id));
}

export async function addInvoiceIntakeFile(
  db: DbClient,
  input: { costSetId: string; invoiceType: string; file: { buffer: Buffer; mimetype: string; originalname?: string } },
  storage: InvoiceFileStorage = invoiceFileStorage,
) {
  return toIntake(await addInvoiceIntakeFileUseCase({ repository: repositoryFor(db), storage }, input));
}

export async function cancelInvoiceIntake(db: DbClient, id: string) {
  return toIntake(await cancelInvoiceIntakeUseCase({ repository: repositoryFor(db) }, id));
}

export async function extractInvoiceIntake(
  db: DbClient,
  id: string,
  deps: { storage?: InvoiceFileStorage; createExtractor?: () => InvoiceExtractor } = {},
) {
  return toIntake(await extractInvoiceIntakeUseCase({
    repository: repositoryFor(db),
    storage: deps.storage ?? invoiceFileStorage,
    createExtractor: deps.createExtractor ?? (() => createInvoiceExtractor()),
  }, id));
}

export async function reviewInvoiceIntake(db: DbClient, id: string, input: { edits: InvoiceEdits; confirm: boolean }) {
  return toIntake(await reviewInvoiceIntakeUseCase({ repository: repositoryFor(db) }, id, input));
}

/** PHASE-2C: stores the bank debit and fetches the official ECB rate for the intake's paid date. */
export async function setInvoiceIntakeBankDebit(db: DbClient, id: string, bankDebitEur: number, fxRate: FxRateLookup = ecbRateLookup) {
  return toIntake(await setIntakeBankDebitAndRateUseCase({ repository: repositoryFor(db), fxRate }, id, bankDebitEur));
}

export async function listInvoiceCostSetProductCandidates(db: DbClient, id: string, query: string) {
  return { items: await listCostSetProductCandidatesUseCase({ repository: repositoryFor(db) }, id, query) };
}

export async function setInvoiceCostSetProducts(db: DbClient, id: string, items: Array<{ productId: string; valueWeightEur?: number | null }>) {
  return { items: await setCostSetProductsUseCase({ repository: repositoryFor(db) }, id, items) };
}

export async function previewInvoiceCostSetAllocation(db: DbClient, id: string) {
  return previewCostSetAllocationUseCase({ repository: repositoryFor(db) }, id);
}

/**
 * PHASE-2C: the canonical purchase command path the ERP routes use (routes/erp.ts /commands/purchases/*), called
 * with the caller's ERP client id. Never writes purchase tables directly.
 */
export function purchaseCommandsFor(db: DbClient, clientId: string, execute: typeof executePurchaseCommand = executePurchaseCommand): PurchaseCommandPort {
  return {
    async createPurchase(payload, idempotencyKey) {
      const out: any = await execute(db, clientId, { commandId: idempotencyKey, idempotencyKey, payload }, "CreatePurchase");
      // A replayed command returns its stored result (entityId) instead of the purchase.
      return { id: String(out?.id ?? out?.entityId) };
    },
    async allocateEqual(purchaseId, idempotencyKey) {
      await execute(db, clientId, { commandId: idempotencyKey, idempotencyKey, payload: { allocationMethod: "Equal" } }, "AllocatePurchaseCosts", purchaseId);
    },
  };
}

export async function approveInvoiceCostSet(
  db: DbClient,
  id: string,
  input: { clientId: string; approvedBy?: string | null },
  execute: typeof executePurchaseCommand = executePurchaseCommand,
) {
  return toCostSet(await approveCostSetUseCase({ repository: repositoryFor(db), purchases: purchaseCommandsFor(db, input.clientId, execute) }, { costSetId: id, approvedBy: input.approvedBy }));
}

export async function getInvoiceIntakeFile(db: DbClient, id: string, storage: InvoiceFileStorage = invoiceFileStorage) {
  return getInvoiceIntakeFileUseCase({ repository: repositoryFor(db), storage }, id);
}

export async function getProductCostBreakdown(db: DbClient, productId: string) {
  return getProductCostBreakdownUseCase({ repository: repositoryFor(db) }, productId);
}
