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

/** PHASE-2B: the extraction/review columns written together with a status change. */
export interface InvoiceIntakeReviewValues {
  extractionJson?: string | null;
  editsJson: string | null;
  invoiceType: string;
  supplierName: string | null;
  supplierVatNumber: string | null;
  platform: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  paidDate: string | null;
  currency: string | null;
  totalOriginal: number | null;
  vatNote: string | null;
  reverseCharge: boolean | null;
  lotNumbers: string | null;
  /** PHASE-2C: cleared (null) whenever the effective values are rewritten. */
  fxRate?: null;
  fxRateDate?: null;
  fxSource?: null;
}

export interface InvoiceIntakeReviewUpdateInput extends ExpectedStatusTransitionInput {
  values: InvoiceIntakeReviewValues;
}

/** PHASE-2C: the official rate and bank debit of one reviewed intake. */
export interface InvoiceIntakeFxUpdateInput extends ExpectedStatusTransitionInput {
  values: { fxRate: number; fxRateDate: string; fxSource: string; bankDebitEur: number };
}

export type InvoiceCostSetItemRecord = Record<string, string | number | boolean | null>;

export interface InvoiceCostSetItemInput {
  id: string;
  productId: string;
  valueWeightEur: number | null;
  weightSource: "ai" | "admin" | null;
}

/** null clears a stale allocation when the preview has blocking issues. */
export interface InvoiceCostSetItemAllocationInput {
  productId: string;
  allocLotEur: number | null;
  allocHammerFeeEur: number | null;
  allocPremiumEur: number | null;
  allocTransportEur: number | null;
  allocForwarderEur: number | null;
  allocFxDiffEur: number | null;
  allocTotalEur: number | null;
}

/** PHASE-2C: read-only product facts the cost set needs (products + their AI intake proposal). */
export interface CostSetProductFacts {
  productId: string;
  sku: string;
  title: string;
  createdAt: string;
  purchaseCost: number | null;
  aiSuggestedPriceEur: number | null;
  fromAiIntake: boolean;
}

export interface CostSetProductConflicts {
  /** Products on a purchase line of a non-cancelled purchase (other than this set's own purchase). */
  onPurchase: string[];
  /** Products in another cost set that is open or approved. */
  inOtherSet: string[];
}

/** PHASE-2C: read-only view of a purchase found by its ERP reference (never written here). */
export interface PurchaseByReference {
  id: string;
  status: string;
  lines: Array<{ productId: string | null; quantity: number; unitPurchaseCost: number }>;
}

export interface InvoiceCostSetApproveInput {
  id: string;
  purchaseId: string;
  approvedBy: string;
  approvedAt: string;
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
 * capability is needed - mirrors repositories/ai-product-intake/types.ts. PHASE-2C: the two multi-row item
 * writes run in one driver-native transaction (sync for SQLite, awaited for PostgreSQL); product, AI proposal
 * and purchase tables are only read here.
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
  /** PHASE-2B: the same atomic conditional UPDATE as transitionIntake, also writing the extraction/review columns. */
  updateIntakeReview(input: InvoiceIntakeReviewUpdateInput): Promise<ExpectedStatusTransitionResult<InvoiceIntakeRecord>>;

  /** PHASE-2C: the same atomic conditional UPDATE, writing the official rate and the bank debit. */
  updateIntakeFx(input: InvoiceIntakeFxUpdateInput): Promise<ExpectedStatusTransitionResult<InvoiceIntakeRecord>>;
  listCostSetItems(costSetId: string): Promise<InvoiceCostSetItemRecord[]>;
  /** Deletes the set's items and inserts the given ones in one transaction. */
  replaceCostSetItems(costSetId: string, items: InvoiceCostSetItemInput[], updatedAt: string): Promise<void>;
  /** Writes the alloc_* columns of the set's items in one transaction. */
  saveCostSetItemAllocations(costSetId: string, rows: InvoiceCostSetItemAllocationInput[], updatedAt: string): Promise<void>;
  /** Writes value_weight_eur / weight_source of the set's items in one transaction. */
  saveCostSetItemWeights(costSetId: string, rows: Array<Omit<InvoiceCostSetItemInput, "id">>, updatedAt: string): Promise<void>;
  findProductFacts(productIds: string[]): Promise<CostSetProductFacts[]>;
  findProductConflicts(input: { costSetId: string; productIds: string[]; ownPurchaseReference: string }): Promise<CostSetProductConflicts>;
  /** AI-intake products that are on no non-cancelled purchase line and in no other open/approved set; newest first. */
  listProductCandidates(input: { costSetId: string; query: string; limit: number; ownPurchaseReference: string }): Promise<CostSetProductFacts[]>;
  findPurchaseByErpReference(erpReferenceId: string): Promise<PurchaseByReference | null>;
  /** Atomic conditional open -> approved, also writing purchase_id / approved_by / approved_at. */
  approveCostSet(input: InvoiceCostSetApproveInput): Promise<ExpectedStatusTransitionResult<InvoiceCostSetRecord>>;
}

export class DuplicateInvoiceFileError extends Error {
  constructor() { super("This file has already been added to this cost set"); this.name = "DuplicateInvoiceFileError"; }
}
