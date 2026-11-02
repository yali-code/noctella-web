import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BadRequestError, ConflictError, InvoiceExtractionFailedError, InvoiceReviewChecksFailedError, NotFoundError } from "../../services/errors";
import { assertAllowedInvoiceFile } from "../../services/invoiceFileGuard";
import { sha256Hex, type InvoiceFileStorage } from "../../services/invoiceFileStorage";
import { DuplicateInvoiceFileError, type InvoiceIntakeRecord, type InvoiceIntakeRepository } from "../../repositories/invoice-intake/types";
import { parseInvoiceExtraction, type InvoiceExtraction } from "../../ai-intake/invoiceExtractionSchema";
import type { InvoiceExtractor } from "../../ai-intake/openAiInvoiceExtractor";
import {
  denormalizedInvoiceColumns,
  editedInvoiceFields,
  effectiveInvoiceValues,
  hasBlockingCheck,
  runInvoiceChecks,
  type InvoiceEdits,
} from "./invoiceReview";

/**
 * PHASE-2A: invoice intake foundation use cases. No FX, allocation, purchase creation or stock change here -
 * a cost set only collects uploaded invoice files; PHASE-2B adds AI extraction and the admin review. Status transitions are atomic conditional updates in the
 * repository; the "set must be open" checks below are read-then-act (single admin user, no stock effect).
 */
export const INVOICE_COST_SET_STATUSES = ["open", "approved", "cancelled"] as const;
export const INVOICE_INTAKE_STATUSES = ["uploaded", "extracted", "reviewed", "cancelled"] as const;
export const INVOICE_TYPES = ["auction", "transport", "forwarder", "other"] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const FILENAME_MAX = 120;

export interface InvoiceIntakeUseCaseDeps {
  repository: InvoiceIntakeRepository;
  storage: InvoiceFileStorage;
}

const now = () => new Date().toISOString();

async function loadCostSet(repository: InvoiceIntakeRepository, id: string) {
  const row = await repository.findCostSetById(id);
  if (!row) throw new NotFoundError("Invoice cost set not found");
  return row;
}

async function loadOpenCostSet(repository: InvoiceIntakeRepository, id: string) {
  const row = await loadCostSet(repository, id);
  if (row.status !== "open") throw new ConflictError("Invoice cost set is not open");
  return row;
}

/** Display-only name: basename of either path style, control characters removed, a conservative charset, bounded. */
export function sanitizeOriginalFilename(raw: string | undefined | null): string | null {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^\p{L}\p{N} ._()-]/gu, "_").replace(/^[.\s]+/, "").trim();
  return cleaned ? cleaned.slice(0, FILENAME_MAX) : null;
}

export async function createInvoiceCostSetUseCase(deps: Pick<InvoiceIntakeUseCaseDeps, "repository">, input: { title: string; notes?: string | null }) {
  const title = String(input.title ?? "").trim();
  if (!title) throw new BadRequestError("Cost set title is required");
  if (title.length > TITLE_MAX) throw new BadRequestError(`Cost set title must be at most ${TITLE_MAX} characters`);
  const notes = input.notes == null ? null : String(input.notes).trim() || null;
  if (notes && notes.length > NOTES_MAX) throw new BadRequestError(`Notes must be at most ${NOTES_MAX} characters`);
  const t = now();
  return deps.repository.createCostSet({ id: randomUUID(), title, notes, createdAt: t, updatedAt: t });
}

export async function listInvoiceCostSetsUseCase(deps: Pick<InvoiceIntakeUseCaseDeps, "repository">, input: { page: number; pageSize: number; status?: string }) {
  const [items, total] = await Promise.all([deps.repository.listCostSets(input), deps.repository.countCostSets(input)]);
  return { items, total, page: input.page, pageSize: input.pageSize };
}

export async function getInvoiceCostSetUseCase(deps: Pick<InvoiceIntakeUseCaseDeps, "repository">, id: string) {
  const costSet = await loadCostSet(deps.repository, id);
  const intakes = await deps.repository.listIntakesByCostSet(id);
  return { costSet, intakes };
}

/** Only an open set can be cancelled; repeating the cancel of an already-cancelled set is an idempotent success. */
export async function cancelInvoiceCostSetUseCase(deps: Pick<InvoiceIntakeUseCaseDeps, "repository">, id: string) {
  const result = await deps.repository.transitionCostSet({ id, expectedStatuses: ["open"], nextStatus: "cancelled", updatedAt: now() });
  if (result.updated) return result.row!;
  if (result.conflict?.field === "id") throw new NotFoundError("Invoice cost set not found");
  if (result.row?.status === "cancelled") return result.row;
  throw new ConflictError("Only an open invoice cost set can be cancelled");
}

export async function addInvoiceIntakeFileUseCase(
  deps: InvoiceIntakeUseCaseDeps,
  input: { costSetId: string; invoiceType: string; file: { buffer: Buffer; mimetype: string; originalname?: string } },
) {
  if (!(INVOICE_TYPES as readonly string[]).includes(input.invoiceType)) throw new BadRequestError("Invalid invoice type");
  await loadOpenCostSet(deps.repository, input.costSetId);
  const { mime, ext } = assertAllowedInvoiceFile(input.file);
  const sha256 = sha256Hex(input.file.buffer);
  if (await deps.repository.findIntakeBySha256(input.costSetId, sha256)) throw new ConflictError(new DuplicateInvoiceFileError().message);

  const intakeId = randomUUID();
  const stored = await deps.storage.save({ costSetId: input.costSetId, intakeId, ext, bytes: input.file.buffer });
  const t = now();
  try {
    return await deps.repository.createIntake({
      id: intakeId,
      costSetId: input.costSetId,
      invoiceType: input.invoiceType,
      fileRelativePath: stored.relativePath,
      fileSha256: stored.sha256,
      fileSizeBytes: stored.sizeBytes,
      fileMime: mime,
      originalFilenameSanitized: sanitizeOriginalFilename(input.file.originalname),
      createdAt: t,
      updatedAt: t,
    });
  } catch (error) {
    // The file was written for this intake id only and no row owns it; remove it so no orphan remains.
    await deps.storage.removeOwnUnpublished(stored.relativePath).catch(() => undefined);
    if (error instanceof DuplicateInvoiceFileError) throw new ConflictError(error.message);
    throw error;
  }
}

/** Marks an intake cancelled while its set is open. The stored file is kept, never deleted. Idempotent. */
export async function cancelInvoiceIntakeUseCase(deps: Pick<InvoiceIntakeUseCaseDeps, "repository">, id: string) {
  const intake = await deps.repository.findIntakeById(id);
  if (!intake) throw new NotFoundError("Invoice intake not found");
  await loadOpenCostSet(deps.repository, intake.costSetId as string);
  const result = await deps.repository.transitionIntake({ id, expectedStatuses: ["uploaded", "extracted", "reviewed"], nextStatus: "cancelled", updatedAt: now() });
  if (result.updated) return result.row!;
  if (result.conflict?.field === "id") throw new NotFoundError("Invoice intake not found");
  if (result.row?.status === "cancelled") return result.row;
  throw new ConflictError("Invoice intake cannot be cancelled from its current status");
}

export interface InvoiceExtractionUseCaseDeps extends InvoiceIntakeUseCaseDeps {
  /** Built per request; throws InvoiceExtractionUnavailableError when the AI provider is not configured. */
  createExtractor: () => InvoiceExtractor;
}

const EXTRACTABLE_STATUSES = ["uploaded", "extracted"] as const;
const REVIEWABLE_STATUSES = ["extracted", "reviewed"] as const;

async function loadIntakeInOpenSet(repository: InvoiceIntakeRepository, id: string) {
  const intake = await repository.findIntakeById(id);
  if (!intake) throw new NotFoundError("Invoice intake not found");
  await loadOpenCostSet(repository, intake.costSetId as string);
  return intake;
}

function storedExtraction(intake: InvoiceIntakeRecord): { output: InvoiceExtraction; model: string | null; extractedAt: string | null } | null {
  if (!intake.extractionJson) return null;
  const parsed = JSON.parse(String(intake.extractionJson));
  const output = parseInvoiceExtraction(parsed?.output);
  return output ? { output, model: parsed.model ?? null, extractedAt: parsed.extractedAt ?? null } : null;
}

function storedEdits(intake: InvoiceIntakeRecord): { edits: InvoiceEdits; editedAt: string | null; confirmed: boolean } | null {
  if (!intake.editsJson) return null;
  const parsed = JSON.parse(String(intake.editsJson));
  return { edits: parsed?.edits ?? {}, editedAt: parsed?.editedAt ?? null, confirmed: parsed?.confirmed === true };
}

function finishIntakeUpdate(result: Awaited<ReturnType<InvoiceIntakeRepository["updateIntakeReview"]>>, message: string) {
  if (result.updated) return result.row!;
  if (result.conflict?.field === "id") throw new NotFoundError("Invoice intake not found");
  throw new ConflictError(message);
}

/**
 * PHASE-2B: reads the stored invoice file with the AI extractor. Allowed while the set is open and the intake is
 * uploaded or extracted; a re-read replaces the extraction and its checks and clears the admin's edits. Nothing
 * is written unless the extractor returns a valid result - any failure leaves the intake unchanged.
 */
export async function extractInvoiceIntakeUseCase(deps: InvoiceExtractionUseCaseDeps, id: string) {
  const intake = await loadIntakeInOpenSet(deps.repository, id);
  if (!(EXTRACTABLE_STATUSES as readonly string[]).includes(intake.status as string)) throw new ConflictError("Only an uploaded or extracted invoice can be read by AI");
  const extractor = deps.createExtractor();
  const bytes = await readFile(await deps.storage.resolveForRead(intake.fileRelativePath as string));

  let raw: unknown;
  try {
    raw = await extractor.extract({ bytes, mime: intake.fileMime as string });
  } catch {
    throw new InvoiceExtractionFailedError();
  }
  const output = parseInvoiceExtraction(raw);
  if (!output) throw new InvoiceExtractionFailedError();

  const checks = runInvoiceChecks(output);
  const t = now();
  const result = await deps.repository.updateIntakeReview({
    id, expectedStatuses: EXTRACTABLE_STATUSES, nextStatus: "extracted", updatedAt: t,
    values: {
      extractionJson: JSON.stringify({ output, checks, model: extractor.modelName, extractedAt: t }),
      editsJson: null,
      ...denormalizedInvoiceColumns(effectiveInvoiceValues(output), intake.invoiceType as string),
    },
  });
  return finishIntakeUpdate(result, "Invoice intake changed while it was being read; reload and try again");
}

/**
 * PHASE-2B: stores the admin's edits over the extraction and re-runs the checks on the effective values. With
 * confirm the intake becomes reviewed, refused (409 with the check list, nothing stored) while TOTAL_MISMATCH
 * fails; without confirm the edits are saved and the intake is (back to) extracted.
 */
export async function reviewInvoiceIntakeUseCase(deps: Pick<InvoiceIntakeUseCaseDeps, "repository">, id: string, input: { edits: InvoiceEdits; confirm: boolean }) {
  const intake = await loadIntakeInOpenSet(deps.repository, id);
  if (!(REVIEWABLE_STATUSES as readonly string[]).includes(intake.status as string)) throw new ConflictError("Only an extracted or reviewed invoice can be reviewed");
  const extraction = storedExtraction(intake);
  if (!extraction) throw new ConflictError("This invoice has no AI extraction to review");

  const edits = input.edits ?? {};
  if (edits.invoiceType != null && !(INVOICE_TYPES as readonly string[]).includes(edits.invoiceType)) throw new BadRequestError("Invalid invoice type");
  const checks = runInvoiceChecks(extraction.output, edits);
  if (input.confirm && hasBlockingCheck(checks)) throw new InvoiceReviewChecksFailedError(checks);

  const t = now();
  const result = await deps.repository.updateIntakeReview({
    id, expectedStatuses: REVIEWABLE_STATUSES, nextStatus: input.confirm ? "reviewed" : "extracted", updatedAt: t,
    values: {
      editsJson: JSON.stringify({ edits, checks, editedAt: t, confirmed: input.confirm }),
      ...denormalizedInvoiceColumns(effectiveInvoiceValues(extraction.output, edits), intake.invoiceType as string),
    },
  });
  return finishIntakeUpdate(result, "Invoice intake changed while it was being reviewed; reload and try again");
}

/** PHASE-2B: the review view of an intake for API output - effective values, the model's evidence/confidence, and fresh checks. */
export function invoiceIntakeReviewView(intake: InvoiceIntakeRecord) {
  const extraction = storedExtraction(intake);
  if (!extraction) return null;
  const stored = storedEdits(intake);
  const edits = stored?.edits ?? {};
  return {
    extracted: extraction.output,
    effective: effectiveInvoiceValues(extraction.output, edits),
    editedFields: editedInvoiceFields(edits),
    checks: runInvoiceChecks(extraction.output, edits),
    model: extraction.model,
    extractedAt: extraction.extractedAt,
    editedAt: stored?.editedAt ?? null,
  };
}

/** Resolves the stored file of an intake for streaming. The absolute path never leaves the API process. */
export async function getInvoiceIntakeFileUseCase(deps: InvoiceIntakeUseCaseDeps, id: string) {
  const intake = await deps.repository.findIntakeById(id);
  if (!intake) throw new NotFoundError("Invoice intake not found");
  const absolutePath = await deps.storage.resolveForRead(intake.fileRelativePath as string);
  return { absolutePath, mime: intake.fileMime as string, sizeBytes: Number(intake.fileSizeBytes), ext: String(intake.fileRelativePath).split(".").pop()! };
}
