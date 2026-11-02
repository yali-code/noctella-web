export type InvoiceCostSetRecord = Record<string, string | number | boolean | null>;
export type InvoiceIntakeRecord = Record<string, string | number | boolean | null>;

export interface InvoiceCostSetCreateInput {
  id: string;
  title: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceCostSetListQuery {
  page: number;
  pageSize: number;
  status?: string;
}

export interface InvoiceIntakeCreateInput {
  id: string;
  costSetId: string;
  invoiceType: string;
  fileRelativePath: string;
  fileSha256: string;
  fileSizeBytes: number;
  fileMime: string;
  originalFilenameSanitized: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpectedStatusTransitionInput {
  id: string;
  expectedStatuses: readonly string[];
  nextStatus: string;
  updatedAt: string;
}

/** Same result shape as AiProductIntakeCancelResult: conflict.field separates not-found from a status mismatch. */
export interface ExpectedStatusTransitionResult<T> {
  updated: boolean;
  row?: T;
  conflict?: { field: "id" | "status"; message: string };
}

/**
 * PHASE-2A: persistence only for invoice_cost_sets and invoice_intakes. Every operation is a single statement
 * (status transitions are atomic conditional UPDATE ... WHERE id = ? AND status IN (...)), so no transaction
 * capability is needed - mirrors repositories/ai-product-intake/types.ts.
 */
export interface InvoiceIntakeRepository {
  createCostSet(input: InvoiceCostSetCreateInput): Promise<InvoiceCostSetRecord>;
  findCostSetById(id: string): Promise<InvoiceCostSetRecord | null>;
  listCostSets(query: InvoiceCostSetListQuery): Promise<InvoiceCostSetRecord[]>;
  countCostSets(query: InvoiceCostSetListQuery): Promise<number>;
  transitionCostSet(input: ExpectedStatusTransitionInput): Promise<ExpectedStatusTransitionResult<InvoiceCostSetRecord>>;
  /** Throws DuplicateInvoiceFileError when (cost_set_id, file_sha256) already exists. */
  createIntake(input: InvoiceIntakeCreateInput): Promise<InvoiceIntakeRecord>;
  findIntakeById(id: string): Promise<InvoiceIntakeRecord | null>;
  findIntakeBySha256(costSetId: string, sha256: string): Promise<InvoiceIntakeRecord | null>;
  listIntakesByCostSet(costSetId: string): Promise<InvoiceIntakeRecord[]>;
  transitionIntake(input: ExpectedStatusTransitionInput): Promise<ExpectedStatusTransitionResult<InvoiceIntakeRecord>>;
}

export class DuplicateInvoiceFileError extends Error {
  constructor() { super("This file has already been added to this cost set"); this.name = "DuplicateInvoiceFileError"; }
}
