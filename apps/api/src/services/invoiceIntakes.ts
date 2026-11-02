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
  return { ...rest, review: invoiceIntakeReviewView(row) };
}

export async function createInvoiceCostSet(db: DbClient, input: { title: string; notes?: string | null }) {
  return toCostSet(await createInvoiceCostSetUseCase({ repository: repositoryFor(db) }, input));
}

export async function listInvoiceCostSets(db: DbClient, query: { page: number; pageSize: number; status?: string }) {
  const result = await listInvoiceCostSetsUseCase({ repository: repositoryFor(db) }, query);
  return { ...result, items: result.items.map(toCostSet) };
}

export async function getInvoiceCostSet(db: DbClient, id: string) {
  const { costSet, intakes } = await getInvoiceCostSetUseCase({ repository: repositoryFor(db) }, id);
  return { ...toCostSet(costSet), intakes: intakes.map(toIntake) };
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

export async function getInvoiceIntakeFile(db: DbClient, id: string, storage: InvoiceFileStorage = invoiceFileStorage) {
  return getInvoiceIntakeFileUseCase({ repository: repositoryFor(db), storage }, id);
}
